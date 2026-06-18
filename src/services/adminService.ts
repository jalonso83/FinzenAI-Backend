import { prisma } from '../lib/prisma';
import { Prisma } from '@prisma/client';
import { PLAN_PRICES } from '../config/adminConfig';
import { getPlanFromPriceId, PLANS } from '../config/stripe';
import {
  FIXED_OPERATING_COSTS,
  TOTAL_FIXED_MONTHLY,
  PAYMENT_FEES,
} from '../config/operatingCosts';
import { logger } from '../utils/logger';

interface UsersListQuery {
  page?: string;
  limit?: string;
  search?: string;
  plan?: string;
  status?: string;
  country?: string;
  cohort?: string; // 'Histórico' | 'Directo' | 'Atribuido'
  sortBy?: string;
  sortOrder?: string;
}

interface DateRange {
  from: Date;
  to: Date;
  prevFrom: Date;
  prevTo: Date;
}

function parseDateRange(query: { from?: string; to?: string }): DateRange {
  const toRaw = query.to ? new Date(query.to) : new Date();
  if (isNaN(toRaw.getTime())) throw new Error('Invalid "to" date parameter');
  toRaw.setHours(23, 59, 59, 999);

  const fromRaw = query.from
    ? new Date(query.from)
    : new Date(toRaw.getTime() - 30 * 24 * 60 * 60 * 1000);
  if (isNaN(fromRaw.getTime())) throw new Error('Invalid "from" date parameter');
  fromRaw.setHours(0, 0, 0, 0);

  if (fromRaw >= toRaw) throw new Error('"from" must be before "to"');

  const rangeDuration = toRaw.getTime() - fromRaw.getTime();
  const prevTo = new Date(fromRaw.getTime() - 1);
  prevTo.setHours(23, 59, 59, 999);
  const prevFrom = new Date(prevTo.getTime() - rangeDuration);
  prevFrom.setHours(0, 0, 0, 0);

  return { from: fromRaw, to: toRaw, prevFrom, prevTo };
}

function pctChange(current: number, previous: number): number {
  if (previous === 0) return current > 0 ? 100 : 0;
  return Math.round(((current - previous) / previous) * 10000) / 100;
}

// Margen de seguridad para trackingStartDate (60s).
// Razón: cuando un user se registra, el flow es:
//   T=0ms      INSERT user (user.createdAt = T0)
//   T=200ms    ingestAttributionEvent dispara CompleteRegistration server-side
// Sin margen, ese mismo user quedaría categorizado como 'Histórico' porque
// user.createdAt < event.createdAt. 60s absorbe ese race condition con holgura
// (un user real que se registró 1 minuto antes del primer evento es legítimamente
// histórico). Valor empíricamente confirmado con caso azazazza887@gmail.com (263ms).
const TRACKING_START_MARGIN_MS = 60_000;

export class AdminService {
  /**
   * Calcula el momento desde el cual el sistema tiene tracking activo.
   * Usado por getUsersList (cohort filter) y getAcquisition (banner histórico).
   * Retorna null si aún no hay ningún evento capturado.
   */
  private static async getTrackingStartDate(): Promise<Date | null> {
    const firstEvent = await prisma.attributionEvent.findFirst({
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    });
    if (!firstEvent) return null;
    return new Date(firstEvent.createdAt.getTime() - TRACKING_START_MARGIN_MS);
  }

  // ─── PULSE ───────────────────────────────────────────────
  static async getPulse(query: { from?: string; to?: string }) {
    const { from, to, prevFrom, prevTo } = parseDateRange(query);

    const [
      totalUsers,
      newRegistrations,
      prevRegistrations,
      activatedUsers,
      planDistribution,
      trialsActive,
      churnedCount,
      activeStartOfPeriod,
      dauRaw,
      mauRaw,
      freeToPaidCount,
      totalFreeUsers,
      retentionD1Data,
      retentionD7Data,
      retentionD30Data,
    ] = await Promise.all([
      // Total users
      prisma.user.count(),

      // New registrations in period
      prisma.user.count({
        where: { createdAt: { gte: from, lte: to } },
      }),

      // Previous period registrations
      prisma.user.count({
        where: { createdAt: { gte: prevFrom, lte: prevTo } },
      }),

      // Activated users in period: cohort with ≥1 transaction.
      // Definition aligned with funnel "Activación" stage in getUsersAnalytics.
      prisma.$queryRawUnsafe<{ cnt: bigint }[]>(`
        SELECT COUNT(DISTINCT u.id)::bigint as cnt FROM users u
        JOIN transactions t ON t."userId" = u.id
        WHERE u."createdAt" >= $1 AND u."createdAt" <= $2
      `, from, to),

      // Plan distribution
      prisma.subscription.groupBy({
        by: ['plan'],
        _count: { plan: true },
        where: { status: { in: ['ACTIVE', 'TRIALING'] } },
      }),

      // Active trials
      prisma.subscription.count({
        where: { status: 'TRIALING' },
      }),

      // Churn: suscripciones de pago cuyo acceso terminó SIN renovar dentro del
      // periodo — basado en el ESTADO de la suscripción (status perdido +
      // currentPeriodEnd dentro de [from, to]), NO en la recencia del pago.
      // Esto evita marcar como churn a suscriptores anuales, que pagan 1 vez al
      // año y naturalmente no pagan el mes siguiente.
      prisma.$queryRawUnsafe<{ cnt: bigint }[]>(`
        SELECT COUNT(*)::bigint as cnt
        FROM subscriptions
        WHERE status IN ('CANCELED', 'UNPAID', 'INCOMPLETE_EXPIRED')
          AND "currentPeriodEnd" >= $1 AND "currentPeriodEnd" <= $2
      `, from, to),

      // Base de churn: suscripciones de pago actualmente activas. El rate se
      // calcula como churned / (churned + activas).
      prisma.subscription.count({
        where: { plan: { in: ['PREMIUM', 'PRO'] }, status: 'ACTIVE' },
      }),

      // DAU: distinct users with HUMAN gamification events in the last 7 days.
      // Excludes system-generated events (scheduler bonuses, meta-events) so we
      // only count real activity, not background jobs.
      prisma.gamificationEvent.findMany({
        where: {
          createdAt: {
            gte: new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000),
            lte: to,
          },
          eventType: {
            notIn: ['email_sync_daily', 'email_tx_imported', 'points_awarded', 'streak_break'],
          },
        },
        distinct: ['userId'],
        select: { userId: true, createdAt: true },
      }),

      // MAU: distinct users with HUMAN gamification events in the last 30 days.
      prisma.gamificationEvent.findMany({
        where: {
          createdAt: {
            gte: new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000),
            lte: to,
          },
          eventType: {
            notIn: ['email_sync_daily', 'email_tx_imported', 'points_awarded', 'streak_break'],
          },
        },
        distinct: ['userId'],
        select: { userId: true },
      }),

      // Free to paid conversions
      prisma.payment.count({
        where: {
          status: 'SUCCEEDED',
          createdAt: { gte: from, lte: to },
        },
      }),

      // Total free users
      prisma.subscription.count({
        where: { plan: 'FREE', status: 'ACTIVE' },
      }),

      // Retention D1: cohort = registered in period AND ≥1 day old.
      // Retained = at least one event on or after day 1.
      prisma.$queryRawUnsafe<{ cohort: bigint; retained: bigint }[]>(`
        SELECT
          COUNT(DISTINCT u.id)::bigint as cohort,
          COUNT(DISTINCT u.id) FILTER (WHERE EXISTS (
            SELECT 1 FROM gamification_events ge
            WHERE ge."userId" = u.id
              AND ge."createdAt" >= u."createdAt" + interval '1 day'
              AND ge."eventType" NOT IN ('email_sync_daily', 'email_tx_imported', 'points_awarded', 'streak_break')
          ))::bigint as retained
        FROM users u
        WHERE u."createdAt" >= $1
          AND u."createdAt" <= LEAST($2::timestamp, NOW() - interval '1 day')
      `, from, to),

      // Retention D7
      prisma.$queryRawUnsafe<{ cohort: bigint; retained: bigint }[]>(`
        SELECT
          COUNT(DISTINCT u.id)::bigint as cohort,
          COUNT(DISTINCT u.id) FILTER (WHERE EXISTS (
            SELECT 1 FROM gamification_events ge
            WHERE ge."userId" = u.id
              AND ge."createdAt" >= u."createdAt" + interval '7 days'
              AND ge."eventType" NOT IN ('email_sync_daily', 'email_tx_imported', 'points_awarded', 'streak_break')
          ))::bigint as retained
        FROM users u
        WHERE u."createdAt" >= $1
          AND u."createdAt" <= LEAST($2::timestamp, NOW() - interval '7 days')
      `, from, to),

      // Retention D30
      prisma.$queryRawUnsafe<{ cohort: bigint; retained: bigint }[]>(`
        SELECT
          COUNT(DISTINCT u.id)::bigint as cohort,
          COUNT(DISTINCT u.id) FILTER (WHERE EXISTS (
            SELECT 1 FROM gamification_events ge
            WHERE ge."userId" = u.id
              AND ge."createdAt" >= u."createdAt" + interval '30 days'
              AND ge."eventType" NOT IN ('email_sync_daily', 'email_tx_imported', 'points_awarded', 'streak_break')
          ))::bigint as retained
        FROM users u
        WHERE u."createdAt" >= $1
          AND u."createdAt" <= LEAST($2::timestamp, NOW() - interval '30 days')
      `, from, to),
    ]);

    // Plan distribution (ACTIVE + TRIALING — para visualización)
    const planCounts: Record<string, number> = {};
    planDistribution.forEach(p => {
      planCounts[p.plan] = p._count.plan;
    });

    // MRR: solo suscripciones ACTIVE (pagando), NO TRIALING
    const paidSubs = planDistribution.filter(p => true); // planDistribution incluye TRIALING
    // Necesitamos contar solo ACTIVE para MRR
    const activePremium = await prisma.subscription.count({ where: { plan: 'PREMIUM', status: 'ACTIVE' } });
    const activePro = await prisma.subscription.count({ where: { plan: 'PRO', status: 'ACTIVE' } });
    const mrrEstimated =
      activePremium * PLAN_PRICES.PREMIUM +
      activePro * PLAN_PRICES.PRO;

    // DAU: average unique users per day over the last 7 days (fixed window).
    // Divide by 7 (not by days-with-activity) so silent days drag the average down.
    const dauByDay = new Map<string, Set<string>>();
    dauRaw.forEach(e => {
      const day = e.createdAt.toISOString().slice(0, 10);
      if (!dauByDay.has(day)) dauByDay.set(day, new Set());
      dauByDay.get(day)!.add(e.userId);
    });
    const dauTotal = Array.from(dauByDay.values()).reduce((sum, s) => sum + s.size, 0);
    const dauAvg = Math.round(dauTotal / 7);
    const mau = mauRaw.length;

    const churnedCountNum = Number(churnedCount[0]?.cnt ?? 0);
    // activeStartOfPeriod ahora es un count de suscripciones de pago activas.
    // Base = activas + las que hicieron churn en el periodo.
    const churnBase = activeStartOfPeriod + churnedCountNum;
    const churnRate = churnBase > 0
      ? Math.round((churnedCountNum / churnBase) * 10000) / 100
      : 0;

    const freeToPaidRate = totalFreeUsers > 0
      ? Math.round((freeToPaidCount / totalFreeUsers) * 10000) / 100
      : 0;

    const retentionPct = (row?: { cohort: bigint; retained: bigint }) => {
      if (!row) return 0;
      const cohort = Number(row.cohort);
      const retained = Number(row.retained);
      return cohort > 0 ? Math.round((retained / cohort) * 10000) / 100 : 0;
    };
    const retentionD1 = retentionPct(retentionD1Data[0]);
    const retentionD7 = retentionPct(retentionD7Data[0]);
    const retentionD30 = retentionPct(retentionD30Data[0]);

    // #8: marcar cuando el período de comparación ("vs período anterior") cruza el
    // inicio del tracking limpio. Si prevFrom cae antes del primer dato confiable,
    // la base previa es parcial → las comparaciones MoM quedan infladas (ej. +625%).
    // El flag es idéntico para todas las métricas de cambio (depende solo del rango),
    // así que el frontend lo lee una vez desde pulse y muestra un disclaimer global.
    // No se oculta el %; solo se advierte.
    const trackingStart = await AdminService.getTrackingStartDate();
    const prevPeriodTruncated = !!(trackingStart && prevFrom < trackingStart);

    return {
      totalUsers,
      newRegistrations,
      registrationChange: pctChange(newRegistrations, prevRegistrations),
      prevPeriodTruncated,
      trackingStart: trackingStart ? trackingStart.toISOString() : null,
      activatedUsers: Number(activatedUsers[0]?.cnt ?? 0),
      planDistribution: planCounts,
      churnRate,
      trialsActive,
      mrrEstimated: Math.round(mrrEstimated * 100) / 100,
      dau: dauAvg,
      mau,
      freeToPaidRate,
      retentionD1,
      retentionD7,
      retentionD30,
      period: { from, to },
    };
  }

  // ─── USERS ANALYTICS ─────────────────────────────────────
  static async getUsersAnalytics(query: { from?: string; to?: string }) {
    const { from, to } = parseDateRange(query);

    const [
      registrationsByDay,
      totalRegistered,
      totalVerified,
      totalOnboarded,
      totalActivated,
      retainedD1,
      retainedD7,
      totalTrialStarted,
      totalPaid,
      cohortD1Raw,
      cohortD7Raw,
    ] = await Promise.all([
      // Registrations by day
      prisma.$queryRawUnsafe<{ day: string; count: bigint }[]>(`
        SELECT DATE("createdAt") as day, COUNT(*)::bigint as count
        FROM users
        WHERE "createdAt" >= $1 AND "createdAt" <= $2
        GROUP BY DATE("createdAt")
        ORDER BY day ASC
      `, from, to),

      // Funnel: total registered in period
      prisma.user.count({
        where: { createdAt: { gte: from, lte: to } },
      }),

      // Funnel: verified (confirmed email) within the cohort
      prisma.user.count({
        where: { createdAt: { gte: from, lte: to }, verified: true },
      }),

      // Funnel: onboarded (completed onboarding)
      prisma.user.count({
        where: { createdAt: { gte: from, lte: to }, onboardingCompleted: true },
      }),

      // Funnel: activated (has at least 1 transaction)
      prisma.$queryRawUnsafe<{ cnt: bigint }[]>(`
        SELECT COUNT(DISTINCT u.id)::bigint as cnt FROM users u
        JOIN transactions t ON t."userId" = u.id
        WHERE u."createdAt" >= $1 AND u."createdAt" <= $2
      `, from, to),

      // Funnel: D1 retained — cohort that had any event on day 1 or after.
      // Restrict cohort to users old enough to be evaluable (≥1 day since registration).
      prisma.$queryRawUnsafe<{ cnt: bigint }[]>(`
        SELECT COUNT(DISTINCT u.id)::bigint as cnt FROM users u
        JOIN gamification_events ge ON ge."userId" = u.id
        WHERE u."createdAt" >= $1
          AND u."createdAt" <= LEAST($2::timestamp, NOW() - interval '1 day')
          AND ge."createdAt" >= u."createdAt" + interval '1 day'
          AND ge."eventType" NOT IN ('email_sync_daily', 'email_tx_imported', 'points_awarded', 'streak_break')
      `, from, to),

      // Funnel: D7 retained — same fix.
      prisma.$queryRawUnsafe<{ cnt: bigint }[]>(`
        SELECT COUNT(DISTINCT u.id)::bigint as cnt FROM users u
        JOIN gamification_events ge ON ge."userId" = u.id
        WHERE u."createdAt" >= $1
          AND u."createdAt" <= LEAST($2::timestamp, NOW() - interval '7 days')
          AND ge."createdAt" >= u."createdAt" + interval '7 days'
          AND ge."eventType" NOT IN ('email_sync_daily', 'email_tx_imported', 'points_awarded', 'streak_break')
      `, from, to),

      // Funnel: cohort users that started a trial (any time after registration).
      // Filter by USER's createdAt, not trialStartedAt — must belong to the cohort.
      prisma.$queryRawUnsafe<{ cnt: bigint }[]>(`
        SELECT COUNT(DISTINCT u.id)::bigint as cnt FROM users u
        JOIN subscriptions s ON s."userId" = u.id
        WHERE u."createdAt" >= $1 AND u."createdAt" <= $2
          AND s."trialStartedAt" IS NOT NULL
      `, from, to),

      // Funnel: cohort users that converted to paid (≥1 successful payment).
      // Filter by USER's createdAt; do NOT filter by current subscription status —
      // a user that paid then canceled still counts as a conversion.
      prisma.$queryRawUnsafe<{ cnt: bigint }[]>(`
        SELECT COUNT(DISTINCT u.id)::bigint as cnt FROM users u
        JOIN payments p ON p."userId" = u.id
        WHERE u."createdAt" >= $1 AND u."createdAt" <= $2
          AND p.status = 'SUCCEEDED'
      `, from, to),

      // Denominador maduro para % de retención D1: usuarios del período con edad
      // suficiente para haber podido cumplir D1 (registrados hace ≥1 día). DEBE
      // coincidir con la cohorte del numerador retainedD1 (mismo LEAST), para que
      // el % no se divida contra `registered` crudo (que incluye users <1 día).
      prisma.$queryRawUnsafe<{ cnt: bigint }[]>(`
        SELECT COUNT(*)::bigint as cnt FROM users
        WHERE "createdAt" >= $1
          AND "createdAt" <= LEAST($2::timestamp, NOW() - interval '1 day')
      `, from, to),

      // Denominador maduro para % de retención D7 (registrados hace ≥7 días).
      prisma.$queryRawUnsafe<{ cnt: bigint }[]>(`
        SELECT COUNT(*)::bigint as cnt FROM users
        WHERE "createdAt" >= $1
          AND "createdAt" <= LEAST($2::timestamp, NOW() - interval '7 days')
      `, from, to),
    ]);

    // Cohort analysis: weekly retention
    const cohorts = await prisma.$queryRawUnsafe<{
      cohort_week: string;
      cohort_size: bigint;
      d1: bigint | null;
      d7: bigint | null;
      d14: bigint | null;
      d30: bigint | null;
    }[]>(`
      WITH cohort AS (
        SELECT id, "createdAt", DATE_TRUNC('week', "createdAt") as cohort_week
        FROM users
        WHERE "createdAt" >= $1 AND "createdAt" <= $2
      )
      SELECT
        c.cohort_week::text as cohort_week,
        COUNT(DISTINCT c.id)::bigint as cohort_size,
        -- Retención medida desde el registro DE CADA USUARIO (no desde el inicio de
        -- semana) y excluyendo eventos de sistema (jobs/scheduler). Devuelve NULL
        -- cuando la cohorte completa aún no cumplió la ventana → "no observable",
        -- no 0%. Madurez: NOW() >= fin de la semana (cohort_week + 7d) + N días.
        (CASE WHEN c.cohort_week + interval '7 days' + interval '1 day' > NOW() THEN NULL
          ELSE COUNT(DISTINCT CASE WHEN ge."createdAt" >= c."createdAt" + interval '1 day' THEN c.id END) END)::bigint as d1,
        (CASE WHEN c.cohort_week + interval '7 days' + interval '7 days' > NOW() THEN NULL
          ELSE COUNT(DISTINCT CASE WHEN ge."createdAt" >= c."createdAt" + interval '7 days' THEN c.id END) END)::bigint as d7,
        (CASE WHEN c.cohort_week + interval '7 days' + interval '14 days' > NOW() THEN NULL
          ELSE COUNT(DISTINCT CASE WHEN ge."createdAt" >= c."createdAt" + interval '14 days' THEN c.id END) END)::bigint as d14,
        (CASE WHEN c.cohort_week + interval '7 days' + interval '30 days' > NOW() THEN NULL
          ELSE COUNT(DISTINCT CASE WHEN ge."createdAt" >= c."createdAt" + interval '30 days' THEN c.id END) END)::bigint as d30
      FROM cohort c
      LEFT JOIN gamification_events ge ON ge."userId" = c.id
        AND ge."eventType" NOT IN ('email_sync_daily', 'email_tx_imported', 'points_awarded', 'streak_break')
      GROUP BY c.cohort_week
      ORDER BY c.cohort_week ASC
    `, from, to);

    const activated = retainedD1[0] ? Number(retainedD1[0].cnt) : 0;

    return {
      registrationsByDay: registrationsByDay.map(r => ({
        day: r.day,
        count: Number(r.count),
      })),
      funnel: {
        registered: totalRegistered,
        verified: totalVerified,
        onboarded: totalOnboarded,
        activated: Number(totalActivated[0]?.cnt ?? 0),
        retainedD1: activated,
        retainedD7: retainedD7[0] ? Number(retainedD7[0].cnt) : 0,
        // Denominadores maduros para los % de retención (cohorte evaluable, NO
        // `registered` crudo). El frontend debe dividir retainedD1/cohortD1 y
        // retainedD7/cohortD7 para evitar inflar el denominador con users sin edad.
        cohortD1: Number(cohortD1Raw[0]?.cnt ?? 0),
        cohortD7: Number(cohortD7Raw[0]?.cnt ?? 0),
        trialStarted: Number(totalTrialStarted[0]?.cnt ?? 0),
        paid: Number(totalPaid[0]?.cnt ?? 0),
      },
      cohorts: cohorts.map(c => ({
        week: c.cohort_week,
        size: Number(c.cohort_size),
        // null = ventana aún no observable (cohorte inmadura) → no convertir a 0.
        d1: c.d1 === null ? null : Number(c.d1),
        d7: c.d7 === null ? null : Number(c.d7),
        d14: c.d14 === null ? null : Number(c.d14),
        d30: c.d30 === null ? null : Number(c.d30),
      })),
      period: { from, to },
    };
  }

  // ─── REVENUE ANALYTICS ───────────────────────────────────
  static async getRevenueAnalytics(query: { from?: string; to?: string }) {
    const { from, to, prevFrom, prevTo } = parseDateRange(query);

    const thirtyDaysAgo = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [
      subscriptionsByStatus,
      trialsActive,
      cancellations30d,
      paymentsSucceeded,
      paymentsFailed,
      totalPaymentAmount,
      currentMrrByPlan,
      previousMrrByPlan,
      mrrTrendData,
      currentActiveSubs,
      stripeRevenueTotal,
      revenuecatRevenueTotal,
    ] = await Promise.all([
      // Subscriptions by status
      prisma.subscription.groupBy({
        by: ['status'],
        _count: { status: true },
      }),

      // Active trials
      prisma.subscription.count({
        where: { status: 'TRIALING' },
      }),

      // Cancelaciones (últimos 30 días): suscripciones de pago cuyo acceso
      // terminó sin renovar (status perdido + currentPeriodEnd en los últimos
      // 30 días). Basado en el ESTADO de la suscripción, NO en la recencia del
      // pago — así un suscriptor anual no se cuenta como cancelado.
      prisma.subscription.count({
        where: {
          status: { in: ['CANCELED', 'UNPAID', 'INCOMPLETE_EXPIRED'] },
          currentPeriodEnd: { gte: thirtyDaysAgo, lte: to },
        },
      }),

      // Payments succeeded in period
      prisma.payment.count({
        where: { status: 'SUCCEEDED', createdAt: { gte: from, lte: to } },
      }),

      // Payments failed in period
      prisma.payment.count({
        where: { status: 'FAILED', createdAt: { gte: from, lte: to } },
      }),

      // Total payment amount in period (REAL dinero)
      prisma.payment.aggregate({
        where: { status: 'SUCCEEDED', createdAt: { gte: from, lte: to } },
        _sum: { amount: true },
      }),

      // Current MRR by plan (basado en suscripciones activas y su tipo de facturación)
      prisma.subscription.findMany({
        where: { status: 'ACTIVE', plan: { not: 'FREE' } },
        select: { plan: true, stripePriceId: true },
      }),

      // Previous MRR by plan (basado en suscripciones activas al inicio del período anterior)
      prisma.$queryRawUnsafe<{ plan: string; stripePriceId: string | null }[]>(`
        SELECT DISTINCT s.plan, s."stripePriceId"
        FROM subscriptions s
        WHERE s.status = 'ACTIVE' AND s.plan != 'FREE'
          AND s."createdAt" < $1
      `, prevTo),

      // MRR trend by month (normalizado: pagos anuales divididos entre 12)
      prisma.$queryRawUnsafe<{ month: string; premium: string; pro: string }[]>(`
        WITH months AS (
          SELECT generate_series(
            DATE_TRUNC('month', $1::timestamp),
            DATE_TRUNC('month', $2::timestamp),
            '1 month'::interval
          ) as month
        )
        SELECT
          m.month::text as month,
          COALESCE(SUM(
            CASE WHEN s.plan = 'PREMIUM' THEN
              CASE WHEN p.description ILIKE '%annual%' THEN p.amount / 12.0 ELSE p.amount END
            ELSE 0 END
          ), 0)::text as premium,
          COALESCE(SUM(
            CASE WHEN s.plan = 'PRO' THEN
              CASE WHEN p.description ILIKE '%annual%' THEN p.amount / 12.0 ELSE p.amount END
            ELSE 0 END
          ), 0)::text as pro
        FROM months m
        LEFT JOIN payments p ON p.status = 'SUCCEEDED'
          AND DATE_TRUNC('month', p."createdAt") = m.month
        LEFT JOIN subscriptions s ON s."userId" = p."userId"
          AND s.status IN ('ACTIVE', 'TRIALING')
        GROUP BY m.month
        ORDER BY m.month ASC
      `, from, to),

      // Current active subs count (para ARPU calculation)
      prisma.subscription.count({
        where: { status: 'ACTIVE', plan: { not: 'FREE' } },
      }),

      // Revenue from Stripe
      prisma.$queryRaw`
        SELECT COALESCE(SUM(p.amount), 0) as total
        FROM payments p
        INNER JOIN subscriptions s ON p."subscriptionId" = s.id
        WHERE p.status = 'SUCCEEDED'
          AND p."createdAt" >= ${from}
          AND p."createdAt" <= ${to}
          AND s."paymentProvider" = 'STRIPE'
      `,

      // Revenue from RevenueCat/Apple
      prisma.$queryRaw`
        SELECT COALESCE(SUM(p.amount), 0) as total
        FROM payments p
        INNER JOIN subscriptions s ON p."subscriptionId" = s.id
        WHERE p.status = 'SUCCEEDED'
          AND p."createdAt" >= ${from}
          AND p."createdAt" <= ${to}
          AND s."paymentProvider" = 'APPLE'
      `,
    ]);

    // Calculate MRR from active subscriptions, normalized for billing period
    let mrrCurrent = 0;
    const currentMrrObj: Record<string, number> = { PREMIUM: 0, PRO: 0 };
    const subscribersByPlan: Record<string, number> = { PREMIUM: 0, PRO: 0 };

    currentMrrByPlan.forEach(sub => {
      const planConfig = PLANS[sub.plan as keyof typeof PLANS];
      if (!planConfig) return;

      // Determine billing period from price ID
      let billingPeriod: 'monthly' | 'yearly' = 'monthly';
      if (sub.stripePriceId) {
        const priceInfo = getPlanFromPriceId(sub.stripePriceId);
        if (priceInfo?.billingPeriod === 'yearly') {
          billingPeriod = 'yearly';
        }
      }

      // Calculate monthly contribution (yearly / 12)
      const monthlyPrice = billingPeriod === 'yearly'
        ? planConfig.price.yearly / 12
        : planConfig.price.monthly;

      mrrCurrent += monthlyPrice;
      if (sub.plan in currentMrrObj) {
        currentMrrObj[sub.plan] += monthlyPrice;
        subscribersByPlan[sub.plan] += 1;
      }
    });

    // Calculate previous MRR similarly
    let mrrPrevious = 0;
    previousMrrByPlan.forEach(sub => {
      const planConfig = PLANS[sub.plan as keyof typeof PLANS];
      if (!planConfig) return;

      let billingPeriod: 'monthly' | 'yearly' = 'monthly';
      if (sub.stripePriceId) {
        const priceInfo = getPlanFromPriceId(sub.stripePriceId);
        if (priceInfo?.billingPeriod === 'yearly') {
          billingPeriod = 'yearly';
        }
      }

      const monthlyPrice = billingPeriod === 'yearly'
        ? planConfig.price.yearly / 12
        : planConfig.price.monthly;

      mrrPrevious += monthlyPrice;
    });

    // ARPU: dinero real / número de suscripciones pagadas
    const arpu = currentActiveSubs > 0 ? Math.round((mrrCurrent / currentActiveSubs) * 100) / 100 : 0;

    // Revenue by plan (REAL dinero)
    const revenueByPlan = {
      PREMIUM: Math.round((currentMrrObj['PREMIUM'] || 0) * 100) / 100,
      PRO: Math.round((currentMrrObj['PRO'] || 0) * 100) / 100,
    };

    // Status distribution
    const statusDist: Record<string, number> = {};
    subscriptionsByStatus.forEach(s => { statusDist[s.status] = s._count.status; });

    return {
      mrrCurrent: Math.round(mrrCurrent * 100) / 100,
      mrrPrevious: Math.round(mrrPrevious * 100) / 100,
      mrrChange: pctChange(mrrCurrent, mrrPrevious),
      arpu,
      subscriptionsByStatus: statusDist,
      revenueByPlan,
      subscribersByPlan: { PREMIUM: subscribersByPlan.PREMIUM, PRO: subscribersByPlan.PRO },
      trialsActive,
      cancellations30d: cancellations30d,
      mrrTrend: mrrTrendData.map(m => ({
        month: m.month,
        mrr: Math.round((Number(m.premium) + Number(m.pro)) * 100) / 100,
        premium: Math.round(Number(m.premium) * 100) / 100,
        pro: Math.round(Number(m.pro) * 100) / 100,
      })),
      payments: {
        succeeded: paymentsSucceeded,
        failed: paymentsFailed,
        totalAmount: totalPaymentAmount._sum.amount || 0,
      },
      revenueByPlatform: {
        stripe: Math.round((stripeRevenueTotal[0]?.total || 0) * 100) / 100,
        revenuecat: Math.round((revenuecatRevenueTotal[0]?.total || 0) * 100) / 100,
      },
      period: { from, to },
    };
  }

  // ─── ENGAGEMENT ──────────────────────────────────────────
  static async getEngagement(query: { from?: string; to?: string }) {
    const { from, to } = parseDateRange(query);

    const [
      totalTransactions,
      activeUsersWithTx,
      totalOnboarded,
      totalUsers,
      zenioActiveUsersData,
      referralsMade,
      referralsConvertedFromCohort,
      registrationsByChannel,
      streakActiveUsersData,
      timeToFirstTxData,
      zenioMessagesAgg,
    ] = await Promise.all([
      // Total transactions in period
      prisma.transaction.count({
        where: { date: { gte: from, lte: to } },
      }),

      // Active users (users with at least 1 transaction in period)
      prisma.$queryRawUnsafe<{ cnt: bigint }[]>(`
        SELECT COUNT(DISTINCT "userId")::bigint as cnt
        FROM transactions
        WHERE date >= $1 AND date <= $2
      `, from, to),

      // Onboarded users
      prisma.user.count({
        where: { onboardingCompleted: true, createdAt: { gte: from, lte: to } },
      }),

      // Total users in period
      prisma.user.count({
        where: { createdAt: { gte: from, lte: to } },
      }),

      // Zenio active users in period: distinct users with cost > 0 in any of
      // the zenio_* features (zenio_v2 = chat principal, zenio_agents = agentes
      // especializados, zenio_transcription = whisper). El nombre genérico
      // 'zenio' NO existe en costByFeature — son sub-features distintas.
      prisma.$queryRawUnsafe<{ cnt: bigint }[]>(`
        SELECT COUNT(DISTINCT "userId")::bigint as cnt
        FROM openai_daily_usage
        WHERE "date" >= $1 AND "date" <= $2
          AND (
            COALESCE(("costByFeature" ->> 'zenio_v2')::float, 0) > 0
            OR COALESCE(("costByFeature" ->> 'zenio_agents')::float, 0) > 0
            OR COALESCE(("costByFeature" ->> 'zenio_transcription')::float, 0) > 0
          )
      `, from, to),

      // Referrals made in period (cohort base)
      prisma.referral.count({
        where: { createdAt: { gte: from, lte: to } },
      }),

      // Referrals from THIS cohort that ended up converting (any time after).
      // Same cohort as referralsMade so the ratio is meaningful.
      // Incluye CONVERTED y REWARDED: el flujo es PENDING → CONVERTED → REWARDED,
      // y el estado final tras una conversión exitosa es REWARDED.
      prisma.referral.count({
        where: {
          createdAt: { gte: from, lte: to },
          status: { in: ['CONVERTED', 'REWARDED'] },
        },
      }),

      // Registrations by country (as channel proxy)
      prisma.user.groupBy({
        by: ['country'],
        _count: { country: true },
        where: { createdAt: { gte: from, lte: to } },
        orderBy: { _count: { country: 'desc' } },
        take: 10,
      }),

      // Users con racha de HÁBITO real en el período.
      // currentStreak >= 2 (NO > 0): una racha de 1 la crea cualquier actividad
      // única (ej. una sola transacción dispara add_tx → currentStreak=1), así que
      // contar > 0 mide "tocó la app una vez", no hábito. Exigir >= 2 significa que
      // el usuario volvió en días consecutivos — señal real de retorno/hábito.
      // (Este es el fix del numerador; cambiar solo el denominador no alcanzaba
      // porque la transacción que cuenta al usuario como activo crea la racha igual.)
      prisma.$queryRawUnsafe<{ cnt: bigint }[]>(`
        SELECT COUNT(DISTINCT "userId")::bigint as cnt
        FROM user_streaks
        WHERE "currentStreak" >= 2
          AND "lastActivityDate" >= $1
          AND "lastActivityDate" <= $2
      `, from, to),

      // Time-to-first-transaction (median hours) and first-tx adoption rate
      // for the cohort of users registered in the period.
      // Cohort eligibility: registered at least 1 hour ago (otherwise no fair
      // chance to have made a tx yet).
      prisma.$queryRawUnsafe<{
        cohort_size: bigint;
        with_first_tx: bigint;
        median_hours: number | null;
      }[]>(`
        WITH cohort AS (
          SELECT id, "createdAt"
          FROM users
          WHERE "createdAt" >= $1
            AND "createdAt" <= LEAST($2::timestamp, NOW() - interval '1 hour')
        ),
        first_tx AS (
          SELECT t."userId", MIN(t."createdAt") as first_tx_at
          FROM transactions t
          INNER JOIN cohort c ON c.id = t."userId"
          GROUP BY t."userId"
        )
        SELECT
          (SELECT COUNT(*) FROM cohort)::bigint as cohort_size,
          (SELECT COUNT(*) FROM first_tx)::bigint as with_first_tx,
          PERCENTILE_CONT(0.5) WITHIN GROUP (
            ORDER BY EXTRACT(EPOCH FROM (ft.first_tx_at - c."createdAt")) / 3600
          ) as median_hours
        FROM cohort c
        LEFT JOIN first_tx ft ON ft."userId" = c.id
        WHERE ft.first_tx_at IS NOT NULL
      `, from, to),

      // Mensajes a Zenio sumados sobre TODAS las suscripciones.
      // Estos son contadores corridos en la fila de suscripción (se incrementan
      // +1 por cada mensaje real en zenioV2), por lo que NO respetan el filtro
      // de período (from/to):
      //   - zenioMessagesTotal = acumulado de por vida (misma fuente que la
      //     columna "Zenio" de la tabla de Usuarios).
      //   - zenioQueriesUsed   = cuota del mes en curso (se resetea cada mes).
      prisma.subscription.aggregate({
        _sum: { zenioMessagesTotal: true, zenioQueriesUsed: true },
      }),
    ]);

    const activeUsers = Number(activeUsersWithTx[0]?.cnt ?? 0);
    const transactionsPerActiveUser = activeUsers > 0
      ? Math.round((totalTransactions / activeUsers) * 100) / 100
      : 0;

    const onboardingRate = totalUsers > 0
      ? Math.round((totalOnboarded / totalUsers) * 10000) / 100
      : 0;

    const zenioActiveUsers = Number(zenioActiveUsersData[0]?.cnt ?? 0);
    const referralConversionRate = referralsMade > 0
      ? Math.round((referralsConvertedFromCohort / referralsMade) * 10000) / 100
      : 0;

    // ─── KPIs de Adopción (cohort-consistent) ──────────────────
    //
    // CRÍTICO: numerator y denominator deben compartir el MISMO cohort
    // (users registrados en el período). Sin esto, los ratios pueden exceder
    // 100% porque legacy users (registrados antes) tienen tx/Zenio uso en el
    // período pero no entran en totalUsers.
    //
    // Patrón inspirado en TTFT (timeToFirstTxData arriba): excluimos users
    // registrados en la última hora porque no tuvieron chance de activarse.
    const adoptionData = await prisma.$queryRawUnsafe<{
      cohort_size: bigint;
      with_tx: bigint;
      with_zenio: bigint;
    }[]>(`
      WITH cohort AS (
        SELECT id
        FROM users
        WHERE "createdAt" >= $1
          AND "createdAt" <= LEAST($2::timestamp, NOW() - interval '1 hour')
      ),
      tx_users AS (
        SELECT DISTINCT t."userId"
        FROM transactions t
        INNER JOIN cohort c ON c.id = t."userId"
        WHERE t.date >= $1 AND t.date <= $2
      ),
      zenio_users AS (
        SELECT DISTINCT o."userId"
        FROM openai_daily_usage o
        INNER JOIN cohort c ON c.id = o."userId"
        WHERE o."date" >= $1 AND o."date" <= $2
          AND (
            COALESCE((o."costByFeature" ->> 'zenio_v2')::float, 0) > 0
            OR COALESCE((o."costByFeature" ->> 'zenio_agents')::float, 0) > 0
            OR COALESCE((o."costByFeature" ->> 'zenio_transcription')::float, 0) > 0
          )
      )
      SELECT
        (SELECT COUNT(*) FROM cohort)::bigint as cohort_size,
        (SELECT COUNT(*) FROM tx_users)::bigint as with_tx,
        (SELECT COUNT(*) FROM zenio_users)::bigint as with_zenio
    `, from, to);

    const adoptionCohortSize = Number(adoptionData[0]?.cohort_size ?? 0);
    const cohortWithTx = Number(adoptionData[0]?.with_tx ?? 0);
    const cohortWithZenio = Number(adoptionData[0]?.with_zenio ?? 0);

    // % Adopción Tx: del cohort registrado en el período, cuántos hicieron ≥1 tx
    const txAdoptionRate = adoptionCohortSize > 0
      ? Math.round((cohortWithTx / adoptionCohortSize) * 10000) / 100
      : 0;

    // % Adopción Zenio: del cohort registrado en el período, cuántos usaron Zenio
    const zenioAdoptionRate = adoptionCohortSize > 0
      ? Math.round((cohortWithZenio / adoptionCohortSize) * 10000) / 100
      : 0;

    // % Racha de Hábito: de los usuarios que REALMENTE usan la app (≥1 transacción
    // en el período), qué % mantiene una racha de HÁBITO real (currentStreak >= 2).
    //
    // Dos correcciones combinadas (el bug original daba ~99.7%, un artefacto):
    //  1. NUMERADOR (clave): `currentStreak >= 2`, no `> 0`. Una racha de 1 la crea
    //     cualquier actividad única (la propia transacción dispara add_tx →
    //     currentStreak=1), así que `> 0` contaba a casi todos. Exigir >= 2 = el
    //     usuario volvió en días consecutivos → señal real de retorno.
    //  2. DENOMINADOR: `activeUsers` (≥1 tx), no `gamification_events` (que está
    //     acoplado a la mecánica de racha y hacía num ≈ denom por construcción).
    //
    // El numerador puede incluir users con racha por daily_open/email_sync sin tx,
    // así que puede superar al denominador → capamos a 100%.
    const streakActiveUsers = Number(streakActiveUsersData[0]?.cnt ?? 0);
    const streakActiveRate = activeUsers > 0
      ? Math.min(100, Math.round((streakActiveUsers / activeUsers) * 10000) / 100)
      : 0;

    // Time-to-first-transaction
    const ttftRow = timeToFirstTxData[0];
    const cohortSize = Number(ttftRow?.cohort_size ?? 0);
    const withFirstTx = Number(ttftRow?.with_first_tx ?? 0);
    const medianHoursRaw = ttftRow?.median_hours;
    const timeToFirstTx = {
      medianHours: medianHoursRaw !== null && medianHoursRaw !== undefined
        ? Math.round(Number(medianHoursRaw) * 10) / 10
        : null,
      firstTxRate: cohortSize > 0
        ? Math.round((withFirstTx / cohortSize) * 10000) / 100
        : 0,
      cohortSize,
    };

    return {
      transactionsPerActiveUser,
      totalTransactions,
      activeUsers,
      onboardingRate,
      zenioActiveUsers,
      zenioAdoptionRate,
      txAdoptionRate,
      streakActiveUsers,
      streakActiveRate,
      timeToFirstTx,
      // Mensajes a Zenio (contadores corridos, all-time / mes en curso — no
      // filtrados por período). zenioMessagesTotal coincide con el total de la
      // columna "Zenio" en la tabla de Usuarios.
      zenioMessagesTotal: zenioMessagesAgg._sum.zenioMessagesTotal ?? 0,
      zenioMessagesThisMonth: zenioMessagesAgg._sum.zenioQueriesUsed ?? 0,
      referrals: {
        total: referralsMade,
        converted: referralsConvertedFromCohort,
        conversionRate: referralConversionRate,
      },
      registrationsByChannel: registrationsByChannel.map(r => ({
        country: r.country,
        count: r._count.country,
      })),
      period: { from, to },
    };
  }

  // ─── UNIT ECONOMICS ──────────────────────────────────────
  static async getUnitEconomics(query: { from?: string; to?: string }) {
    const { from, to } = parseDateRange(query);

    // Days in selected period (used to scale variable costs to monthly).
    const periodDays = Math.max(1, Math.round((to.getTime() - from.getTime()) / 86400000));
    const monthlyScale = 30 / periodDays;

    const [
      activeUsersWithTx,
      totalRegisteredUsers,
      totalActiveSubs,
      currentMrrByPlan,
      openAICostInPeriod,
      stripePayments,
      revenueCatPayments,
    ] = await Promise.all([
      // Users with ≥1 tx in period (active users denominator)
      prisma.$queryRawUnsafe<{ cnt: bigint }[]>(`
        SELECT COUNT(DISTINCT "userId")::bigint as cnt
        FROM transactions
        WHERE date >= $1 AND date <= $2
      `, from, to),

      // Total users registered ever (for per-total-user metrics)
      prisma.user.count(),

      // Active paid subscriptions (for ARPU)
      prisma.subscription.count({
        where: { status: 'ACTIVE', plan: { not: 'FREE' } },
      }),

      // Active subs with priceId (for MRR calc)
      prisma.subscription.findMany({
        where: { status: 'ACTIVE', plan: { not: 'FREE' } },
        select: { plan: true, stripePriceId: true },
      }),

      // OpenAI cost in period
      prisma.openAIDailyUsage.aggregate({
        where: { date: { gte: from, lte: to } },
        _sum: { totalCost: true },
      }),

      // Stripe payments in period (for fees calc)
      prisma.$queryRawUnsafe<{ amount: number }[]>(`
        SELECT p.amount
        FROM payments p
        INNER JOIN subscriptions s ON s.id = p."subscriptionId"
        WHERE p.status = 'SUCCEEDED'
          AND p."createdAt" >= $1 AND p."createdAt" <= $2
          AND s."paymentProvider" = 'STRIPE'
      `, from, to),

      // RevenueCat (Apple) payments in period
      prisma.$queryRawUnsafe<{ amount: number }[]>(`
        SELECT p.amount
        FROM payments p
        INNER JOIN subscriptions s ON s.id = p."subscriptionId"
        WHERE p.status = 'SUCCEEDED'
          AND p."createdAt" >= $1 AND p."createdAt" <= $2
          AND s."paymentProvider" = 'APPLE'
      `, from, to),
    ]);

    // ── MRR del período (mensual recurrente actual) ────────────────
    let mrrCurrent = 0;
    currentMrrByPlan.forEach(sub => {
      const planConfig = PLANS[sub.plan as keyof typeof PLANS];
      if (!planConfig) return;
      let billingPeriod: 'monthly' | 'yearly' = 'monthly';
      if (sub.stripePriceId) {
        const priceInfo = getPlanFromPriceId(sub.stripePriceId);
        if (priceInfo?.billingPeriod === 'yearly') billingPeriod = 'yearly';
      }
      mrrCurrent += billingPeriod === 'yearly'
        ? planConfig.price.yearly / 12
        : planConfig.price.monthly;
    });

    // ── Variable costs (cash basis del período, escalados a mensual) ─
    const openAICostPeriod = Number(openAICostInPeriod._sum.totalCost ?? 0);
    const openAICostMonthly = openAICostPeriod * monthlyScale;

    // Stripe fees: 2.9% × amount + $0.30 por payment
    const stripeFeesPeriod = stripePayments.reduce(
      (sum, p) => sum + (p.amount * PAYMENT_FEES.stripe.percentage + PAYMENT_FEES.stripe.fixed),
      0
    );
    const stripeFeesMonthly = stripeFeesPeriod * monthlyScale;

    // RevenueCat fees: 30% Apple + 1% RC = 31% del gross
    const rcFeesPeriod = revenueCatPayments.reduce(
      (sum, p) => sum + p.amount * (PAYMENT_FEES.revenueCat.apple + PAYMENT_FEES.revenueCat.revenueCat),
      0
    );
    const rcFeesMonthly = rcFeesPeriod * monthlyScale;

    const totalVariableMonthly = openAICostMonthly + stripeFeesMonthly + rcFeesMonthly;

    // ── Costo total mensual ────────────────────────────────────────
    const totalCostMonthly = TOTAL_FIXED_MONTHLY + totalVariableMonthly;

    // ── Métricas derivadas ─────────────────────────────────────────
    const activeUsers = Number(activeUsersWithTx[0]?.cnt ?? 0);
    const totalUsers = totalRegisteredUsers;
    const arpu = totalActiveSubs > 0 ? mrrCurrent / totalActiveSubs : 0;

    // Por usuario activo (los que generan carga real este período)
    const costPerUser = activeUsers > 0 ? totalCostMonthly / activeUsers : 0;
    const costAIPerUser = activeUsers > 0 ? openAICostMonthly / activeUsers : 0;
    const costInfraPerUser = activeUsers > 0 ? TOTAL_FIXED_MONTHLY / activeUsers : 0;

    // Por usuario total (incluye dormidos — vista alternativa más conservadora)
    const costPerTotalUser = totalUsers > 0 ? totalCostMonthly / totalUsers : 0;
    const costAIPerTotalUser = totalUsers > 0 ? openAICostMonthly / totalUsers : 0;
    const costInfraPerTotalUser = totalUsers > 0 ? TOTAL_FIXED_MONTHLY / totalUsers : 0;

    // Cash flow mensual: MRR menos costo total
    // Negativo = pérdida (burn), positivo = ganancia
    const cashFlowMonthly = mrrCurrent - totalCostMonthly;

    // Margen Bruto = (MRR - costos variables) / MRR × 100.
    // Solo variable costs porque margen bruto excluye fijos por convención SaaS.
    const grossMargin = mrrCurrent > 0
      ? ((mrrCurrent - totalVariableMonthly) / mrrCurrent) * 100
      : 0;

    // Break-Even users: costos fijos mensuales / contribución por user.
    // La "contribución" es lo que cada paying user aporta a cubrir costos fijos
    // DESPUÉS de cubrir su propio costo variable.
    //
    // Costo variable POR PAYING USER ADICIONAL:
    //   1) Su cuota proporcional de OpenAI (asumimos uso similar al activo promedio)
    //   2) Sus fees de pago (calculados como tasa blended observada × ARPU)
    //
    // NOTA: la fórmula anterior dividía TODO el costo variable entre paying users,
    // lo cual era incorrecto porque OpenAI lo consumen también los free users.
    const openAIPerActiveUser = activeUsers > 0 ? openAICostMonthly / activeUsers : 0;

    // Tasa de fees observada (Stripe ~3%, Apple+RC ~31%) ponderada por revenue real
    const totalRevenuePeriod =
      stripePayments.reduce((s, p) => s + p.amount, 0) +
      revenueCatPayments.reduce((s, p) => s + p.amount, 0);
    const totalFeesPeriod = stripeFeesPeriod + rcFeesPeriod;
    const blendedFeeRate = totalRevenuePeriod > 0
      ? totalFeesPeriod / totalRevenuePeriod
      : PAYMENT_FEES.stripe.percentage; // fallback: solo Stripe %
    const paymentFeePerPayingUser = arpu * blendedFeeRate;

    const variableCostPerPayingUser = openAIPerActiveUser + paymentFeePerPayingUser;
    const contribPerUser = arpu - variableCostPerPayingUser;
    const breakEvenUsers = contribPerUser > 0
      ? Math.ceil(TOTAL_FIXED_MONTHLY / contribPerUser)
      : null; // null = imposible (ARPU no cubre ni los costos variables — revisar pricing)

    const progressBreakEven = breakEvenUsers && breakEvenUsers > 0
      ? Math.min(100, Math.round((totalActiveSubs / breakEvenUsers) * 100))
      : 0;

    // ── Cost breakdown para tabla (todos los conceptos) ────────────
    const breakdownItems = [
      ...FIXED_OPERATING_COSTS.map(c => ({
        concepto: c.name,
        category: c.category,
        costo: Math.round(c.monthlyAmount * 100) / 100,
        type: 'fixed' as const,
      })),
      {
        concepto: 'OpenAI API',
        category: 'variable' as const,
        costo: Math.round(openAICostMonthly * 100) / 100,
        type: 'variable' as const,
      },
      {
        concepto: 'Stripe fees',
        category: 'variable' as const,
        costo: Math.round(stripeFeesMonthly * 100) / 100,
        type: 'variable' as const,
      },
      {
        concepto: 'RevenueCat + Apple fees',
        category: 'variable' as const,
        costo: Math.round(rcFeesMonthly * 100) / 100,
        type: 'variable' as const,
      },
    ];

    const totalForPct = breakdownItems.reduce((s, i) => s + i.costo, 0);
    const breakdown = breakdownItems
      .map(i => ({
        ...i,
        porcentaje: totalForPct > 0 ? Math.round((i.costo / totalForPct) * 1000) / 10 : 0,
      }))
      .sort((a, b) => b.costo - a.costo);

    return {
      // Costos fijos
      fixedCosts: {
        items: FIXED_OPERATING_COSTS,
        total: Math.round(TOTAL_FIXED_MONTHLY * 100) / 100,
      },
      // Costos variables (escalados a equivalente mensual)
      variableCosts: {
        openAI: Math.round(openAICostMonthly * 100) / 100,
        stripeFees: Math.round(stripeFeesMonthly * 100) / 100,
        revenueCatFees: Math.round(rcFeesMonthly * 100) / 100,
        total: Math.round(totalVariableMonthly * 100) / 100,
      },
      totalCostMonthly: Math.round(totalCostMonthly * 100) / 100,
      // Cash flow mensual: positivo=profit, negativo=burn
      cashFlowMonthly: Math.round(cashFlowMonthly * 100) / 100,
      // Métricas por usuario activo (con tx en período)
      costPerUser: Math.round(costPerUser * 100) / 100,
      costAIPerUser: Math.round(costAIPerUser * 100) / 100,
      costInfraPerUser: Math.round(costInfraPerUser * 100) / 100,
      // Métricas por usuario total (incluye dormidos)
      costPerTotalUser: Math.round(costPerTotalUser * 100) / 100,
      costAIPerTotalUser: Math.round(costAIPerTotalUser * 100) / 100,
      costInfraPerTotalUser: Math.round(costInfraPerTotalUser * 100) / 100,
      // Margen y break-even
      grossMargin: Math.round(grossMargin * 100) / 100,
      breakEven: {
        usersNeeded: breakEvenUsers,
        currentPayingUsers: totalActiveSubs,
        progressPct: progressBreakEven,
      },
      mrrCurrent: Math.round(mrrCurrent * 100) / 100,
      arpu: Math.round(arpu * 100) / 100,
      activeUsers,
      totalUsers,
      // Tabla de desglose
      breakdown,
      period: { from, to, days: periodDays },
    };
  }

  // ─── FINANCIAL HEALTH ────────────────────────────────────
  // Independiente del selector de período: siempre mira "mes actual" calendario
  // y "bruto acumulado desde lanzamiento" (FINANCIAL_TRACKING_START).
  static async getFinancialHealth() {
    const now = new Date();
    const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
    const endOfMonth = now; // hasta este momento

    const [
      grossTotalAgg,
      incomeThisMonthAgg,
      openAIThisMonthAgg,
      stripePaymentsThisMonth,
      rcPaymentsThisMonth,
    ] = await Promise.all([
      // 1) Ingreso Bruto Total: TODOS los pagos exitosos sin filtro de fecha.
      // Es el dinero total que ha entrado a la empresa desde su existencia.
      prisma.payment.aggregate({
        where: { status: 'SUCCEEDED' },
        _sum: { amount: true },
      }),

      // 2) Ingresos del mes actual
      prisma.payment.aggregate({
        where: {
          status: 'SUCCEEDED',
          createdAt: { gte: startOfMonth, lte: endOfMonth },
        },
        _sum: { amount: true },
      }),

      // 3) Costo OpenAI del mes actual
      prisma.openAIDailyUsage.aggregate({
        where: { date: { gte: startOfMonth, lte: endOfMonth } },
        _sum: { totalCost: true },
      }),

      // 4) Stripe payments del mes (para fees)
      prisma.$queryRawUnsafe<{ amount: number }[]>(`
        SELECT p.amount
        FROM payments p
        INNER JOIN subscriptions s ON s.id = p."subscriptionId"
        WHERE p.status = 'SUCCEEDED'
          AND p."createdAt" >= $1 AND p."createdAt" <= $2
          AND s."paymentProvider" = 'STRIPE'
      `, startOfMonth, endOfMonth),

      // 5) RevenueCat payments del mes (para fees)
      prisma.$queryRawUnsafe<{ amount: number }[]>(`
        SELECT p.amount
        FROM payments p
        INNER JOIN subscriptions s ON s.id = p."subscriptionId"
        WHERE p.status = 'SUCCEEDED'
          AND p."createdAt" >= $1 AND p."createdAt" <= $2
          AND s."paymentProvider" = 'APPLE'
      `, startOfMonth, endOfMonth),
    ]);

    const grossIncomeTotal = Number(grossTotalAgg._sum.amount ?? 0);
    const incomeThisMonth = Number(incomeThisMonthAgg._sum.amount ?? 0);
    const openAIThisMonth = Number(openAIThisMonthAgg._sum.totalCost ?? 0);

    const stripeFeesThisMonth = stripePaymentsThisMonth.reduce(
      (sum, p) => sum + (p.amount * PAYMENT_FEES.stripe.percentage + PAYMENT_FEES.stripe.fixed),
      0
    );
    const rcFeesThisMonth = rcPaymentsThisMonth.reduce(
      (sum, p) => sum + p.amount * (PAYMENT_FEES.revenueCat.apple + PAYMENT_FEES.revenueCat.revenueCat),
      0
    );
    const variableExpensesThisMonth = openAIThisMonth + stripeFeesThisMonth + rcFeesThisMonth;
    const fixedExpensesThisMonth = TOTAL_FIXED_MONTHLY;
    const totalExpensesThisMonth = fixedExpensesThisMonth + variableExpensesThisMonth;

    // Cash flow: positivo = profit, negativo = burn
    const cashFlowThisMonth = incomeThisMonth - totalExpensesThisMonth;
    // Burn rate: positivo = pérdida mensual neta, negativo = ganancia mensual
    const burnRate = -cashFlowThisMonth;

    // Runway: cuántos meses dura el bruto acumulado al ritmo de burn actual
    // Si no hay burn (cashFlow ≥ 0) → infinito (representado como null)
    const runway = burnRate > 0
      ? Math.round((grossIncomeTotal / burnRate) * 10) / 10
      : null;

    // Estado: clasificación cualitativa
    let estado: 'Sostenible' | 'Precaución' | 'Crítico';
    if (cashFlowThisMonth >= 0) {
      estado = 'Sostenible';
    } else if (runway !== null && runway >= 6) {
      estado = 'Precaución';
    } else {
      estado = 'Crítico';
    }

    return {
      grossIncomeTotal: Math.round(grossIncomeTotal * 100) / 100,
      incomeThisMonth: Math.round(incomeThisMonth * 100) / 100,
      expensesThisMonth: Math.round(totalExpensesThisMonth * 100) / 100,
      fixedExpensesThisMonth: Math.round(fixedExpensesThisMonth * 100) / 100,
      variableExpensesThisMonth: Math.round(variableExpensesThisMonth * 100) / 100,
      cashFlowThisMonth: Math.round(cashFlowThisMonth * 100) / 100,
      burnRate: Math.round(burnRate * 100) / 100,
      runway, // meses, o null si no hay burn
      estado,
      currentMonth: {
        from: startOfMonth.toISOString().split('T')[0],
        to: endOfMonth.toISOString().split('T')[0],
      },
    };
  }

  // ─── USERS LIST (CRM) ─────────────────────────────────────
  static async getUsersList(query: UsersListQuery) {
    const page = Math.max(1, parseInt(query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(query.limit || '20', 10)));
    const skip = (page - 1) * limit;
    const search = query.search?.trim() || '';
    const plan = query.plan?.toUpperCase();
    const status = query.status?.toUpperCase();
    const country = query.country || '';
    const sortBy = query.sortBy || 'createdAt';
    const sortOrder = (query.sortOrder || 'desc') as 'asc' | 'desc';

    // Build where clause
    const where: Prisma.UserWhereInput = {};

    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { lastName: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (plan && ['FREE', 'PREMIUM', 'PRO'].includes(plan)) {
      if (plan === 'FREE') {
        // FREE = no subscription OR subscription.plan = FREE
        where.AND = [
          {
            OR: [
              { subscription: null },
              { subscription: { plan: 'FREE' } },
            ],
          },
        ];
      } else {
        where.subscription = { plan: plan as any };
      }
    }

    if (status && ['NO_VERIFICADO', 'VERIFICADO', 'SIN_ONBOARDING', 'EN_TRIAL', 'ACTIVO', 'CANCELADO'].includes(status)) {
      let filter: any;
      const now = new Date();

      if (status === 'NO_VERIFICADO') {
        filter = { verified: false };
      } else if (status === 'VERIFICADO') {
        // Todos los usuarios con email verificado (independiente de onboarding/trial/plan).
        filter = { verified: true };
      } else if (status === 'SIN_ONBOARDING') {
        filter = { AND: [{ verified: true }, { onboardingCompleted: false }] };
      } else if (status === 'EN_TRIAL') {
        filter = { AND: [
          { verified: true },
          { subscription: {
            AND: [
              { status: 'TRIALING' },
              { trialEndsAt: { not: null } },
              { trialEndsAt: { gt: now } }
            ]
          } }
        ]};
      } else if (status === 'ACTIVO') {
        filter = { AND: [
          { verified: true },
          { onboardingCompleted: true },
          { subscription: {
            status: 'ACTIVE',
            OR: [
              { trialEndsAt: null },
              { trialEndsAt: { lte: now } }
            ]
          } }
        ]};
      } else if (status === 'CANCELADO') {
        filter = { subscription: { status: 'CANCELED' } };
      }

      if (where.AND) {
        (where.AND as any[]).push(filter);
      } else {
        Object.assign(where, filter);
      }
    }

    if (country) {
      where.country = country;
    }

    // Build orderBy
    const allowedSorts = ['createdAt', 'name', 'email', 'country'];
    const orderByField = allowedSorts.includes(sortBy) ? sortBy : 'createdAt';
    const orderBy: Prisma.UserOrderByWithRelationInput = { [orderByField]: sortOrder };

    // Filtro por plataforma (Android/iOS/Desconocido) — se deriva del userAgent
    // del evento `CompleteRegistration` en attribution_events.
    //   Android: UA contiene 'okhttp' o 'Dalvik'
    //   iOS: UA contiene 'CFNetwork' o 'Darwin'
    //   Desconocido: sin CompleteRegistration o UA fuera de los patrones anteriores
    const ANDROID_UA_PATTERNS = ['okhttp', 'Dalvik'];
    const IOS_UA_PATTERNS = ['CFNetwork', 'Darwin'];

    const platformFilter = query.cohort?.trim();
    if (platformFilter && ['Android', 'iOS', 'Desconocido'].includes(platformFilter)) {
      const androidMatch: Prisma.UserWhereInput = {
        attributionEvents: {
          some: {
            eventName: 'CompleteRegistration',
            OR: ANDROID_UA_PATTERNS.map(p => ({ userAgent: { contains: p } })),
          },
        },
      };
      const iosMatch: Prisma.UserWhereInput = {
        attributionEvents: {
          some: {
            eventName: 'CompleteRegistration',
            OR: IOS_UA_PATTERNS.map(p => ({ userAgent: { contains: p } })),
          },
        },
      };

      let platformClause: Prisma.UserWhereInput;
      if (platformFilter === 'Android') {
        platformClause = androidMatch;
      } else if (platformFilter === 'iOS') {
        platformClause = iosMatch;
      } else {
        // Desconocido = NO matchea ni Android ni iOS
        platformClause = { AND: [{ NOT: androidMatch }, { NOT: iosMatch }] };
      }

      const existingAnd = (where.AND as Prisma.UserWhereInput[] | undefined) ?? [];
      where.AND = [...existingAnd, platformClause];
    }

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        select: {
          id: true,
          name: true,
          lastName: true,
          email: true,
          country: true,
          verified: true,
          createdAt: true,
          subscription: {
            select: {
              plan: true,
              status: true,
              trialEndsAt: true,
              currentPeriodEnd: true,
              zenioMessagesTotal: true,
            },
          },
          _count: {
            select: {
              transactions: true,
              goals: true,
            },
          },
        },
        orderBy,
        skip,
        take: limit,
      }),
      prisma.user.count({ where }),
    ]);

    // Get last activity for these users via raw query
    const userIds = users.map(u => u.id);
    let lastActivityMap: Record<string, Date> = {};
    let platformMap: Record<string, 'Android' | 'iOS' | 'Desconocido'> = {};
    let goalContributionsMap: Record<string, number> = {};

    if (userIds.length > 0) {
      const [lastActivities, registrationUAs, goalContributions] = await Promise.all([
        prisma.$queryRawUnsafe<{ userId: string; lastActivity: Date }[]>(
          `SELECT "userId", MAX("createdAt") as "lastActivity"
           FROM gamification_events
           WHERE "userId" = ANY($1::text[])
           GROUP BY "userId"`,
          userIds
        ),
        // Tomamos el UA del CompleteRegistration más reciente por user.
        prisma.$queryRawUnsafe<{ userId: string; userAgent: string | null }[]>(
          `SELECT DISTINCT ON ("userId") "userId", "userAgent"
           FROM attribution_events
           WHERE "userId" = ANY($1::text[])
             AND "eventName" = 'CompleteRegistration'
           ORDER BY "userId", "eventTime" DESC`,
          userIds
        ),
        // Total de contribuciones a metas por usuario (suma del contador por meta).
        prisma.goal.groupBy({
          by: ['userId'],
          where: { userId: { in: userIds } },
          _sum: { contributionsCount: true },
        }),
      ]);

      lastActivities.forEach(a => {
        lastActivityMap[a.userId] = a.lastActivity;
      });

      goalContributions.forEach(g => {
        goalContributionsMap[g.userId] = g._sum.contributionsCount || 0;
      });

      registrationUAs.forEach(r => {
        const ua = r.userAgent ?? '';
        if (ANDROID_UA_PATTERNS.some(p => ua.includes(p))) {
          platformMap[r.userId] = 'Android';
        } else if (IOS_UA_PATTERNS.some(p => ua.includes(p))) {
          platformMap[r.userId] = 'iOS';
        } else {
          platformMap[r.userId] = 'Desconocido';
        }
      });
    }

    // El campo se sigue llamando `cohort` para no romper consumidores existentes,
    // pero los valores ahora representan la plataforma (Android / iOS / Desconocido)
    // derivada del userAgent del evento CompleteRegistration.
    const mappedUsers = users.map(u => {
      const cohort: 'Android' | 'iOS' | 'Desconocido' = platformMap[u.id] ?? 'Desconocido';
      return {
        id: u.id,
        name: u.name,
        lastName: u.lastName,
        email: u.email,
        country: u.country,
        verified: u.verified,
        createdAt: u.createdAt,
        plan: u.subscription?.plan || 'FREE',
        subscriptionStatus: u.subscription?.status || null,
        trialEndsAt: u.subscription?.trialEndsAt || null,
        currentPeriodEnd: u.subscription?.currentPeriodEnd || null,
        transactionCount: u._count.transactions,
        zenioQueries: u.subscription?.zenioMessagesTotal || 0,
        goalCount: u._count.goals,
        goalContributions: goalContributionsMap[u.id] || 0,
        lastActivity: lastActivityMap[u.id] || null,
        cohort,
      };
    });

    return {
      users: mappedUsers,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  static async getDistinctCountries() {
    const result = await prisma.user.findMany({
      distinct: ['country'],
      select: { country: true },
      orderBy: { country: 'asc' },
    });
    return result.map(r => r.country).filter(Boolean);
  }

  // ─── ACQUISITION ──────────────────────────────────────────
  // Métricas de adquisición basadas en attribution_events.
  // El "tracking start date" se calcula dinámicamente desde el primer evento
  // capturado, restando 60s de margen para absorber race conditions con
  // eventos server-side (CompleteRegistration se dispara ~200ms después del
  // INSERT del user). Eso permite separar correctamente cohort histórico
  // (users registrados antes del tracking) del cohort attributed.
  static async getAcquisition(query: { from?: string; to?: string }) {
    const { from, to, prevFrom, prevTo } = parseDateRange(query);

    // Tracking start con margen — ver helper para detalles del race condition.
    const trackingStartDate = await AdminService.getTrackingStartDate();

    // Cohort histórico: users registrados ANTES del tracking
    const historicalUsersCount = trackingStartDate
      ? await prisma.user.count({
          where: { createdAt: { lt: trackingStartDate } },
        })
      : await prisma.user.count();

    // Helpers de conteo con semántica correcta:
    //  - countRawEvents: cada disparo cuenta (PageView, Lead — el usuario puede generar varios)
    //  - countUniqueVisitors: distinct anonymousId|userId (visitantes únicos)
    //  - countUniqueUsers: distinct userId (usuarios únicos — para CompleteRegistration y Subscribe,
    //    evita inflar por re-deliveries de webhook o renovaciones)
    //
    // NOISE FILTERS (3 capas):
    //   1. HeadlessChrome UA → bots/crawlers
    //   2. campaign tipo __XXX__ → macros TikTok no resueltas (preview/scan)
    //   3. ttclid con "Preview_" → clicks de preview del advertiser
    // Mantiene userAgent NULL y ttclid NULL (eventos server-side legítimos
    // como Subscribe vía webhook no tienen UA/ttclid).
    const NOISE_SQL_FILTERS = `
      AND ("userAgent" IS NULL OR "userAgent" NOT ILIKE '%HeadlessChrome%')
      AND ("campaign" IS NULL OR "campaign" NOT LIKE '\\_\\_%\\_\\_' ESCAPE '\\')
      AND ("ttclid" IS NULL OR "ttclid" NOT LIKE '%Preview\\_%' ESCAPE '\\')
    `;

    // Cada noise filter se aplica como su propio AND con OR(IS NULL OR NOT...).
    // No usar NOT { OR: [...] } de Prisma: en three-valued logic SQL,
    // FALSE OR NULL = NULL → NOT NULL = NULL → la fila se excluye, lo cual
    // descartaba silenciosamente todos los Leads con campaign o ttclid NULL.
    const countRawEvents = (eventName: string, rangeFrom: Date, rangeTo: Date) =>
      prisma.attributionEvent.count({
        where: {
          eventName,
          eventTime: { gte: rangeFrom, lte: rangeTo },
          AND: [
            {
              OR: [
                { userAgent: null },
                { userAgent: { not: { contains: 'HeadlessChrome' } } },
              ],
            },
            {
              OR: [
                { campaign: null },
                {
                  NOT: {
                    AND: [
                      { campaign: { startsWith: '__' } },
                      { campaign: { endsWith: '__' } },
                    ],
                  },
                },
              ],
            },
            {
              OR: [
                { ttclid: null },
                { NOT: { ttclid: { contains: 'Preview_' } } },
              ],
            },
          ],
        },
      });

    const countUniqueVisitors = async (rangeFrom: Date, rangeTo: Date): Promise<number> => {
      const result = await prisma.$queryRawUnsafe<{ cnt: bigint }[]>(
        `SELECT COUNT(DISTINCT COALESCE("anonymousId", "userId"))::bigint as cnt
         FROM attribution_events
         WHERE "eventName" = 'PageView'
           AND "eventTime" >= $1 AND "eventTime" <= $2
           ${NOISE_SQL_FILTERS}`,
        rangeFrom,
        rangeTo,
      );
      return Number(result[0]?.cnt ?? 0);
    };

    const countUniqueUsersByEvent = async (
      eventName: string,
      rangeFrom: Date,
      rangeTo: Date,
    ): Promise<number> => {
      const result = await prisma.$queryRawUnsafe<{ cnt: bigint }[]>(
        `SELECT COUNT(DISTINCT "userId")::bigint as cnt
         FROM attribution_events
         WHERE "eventName" = $1
           AND "userId" IS NOT NULL
           AND "eventTime" >= $2 AND "eventTime" <= $3
           ${NOISE_SQL_FILTERS}`,
        eventName,
        rangeFrom,
        rangeTo,
      );
      return Number(result[0]?.cnt ?? 0);
    };

    const [
      pageViews,           // unique visitors
      leads,               // raw clicks (Lead = click en CTA, sí queremos contar todos)
      registrations,       // unique users
      subscriptions,       // unique users
      prevPageViews,
      prevLeads,
      prevRegistrations,
      prevSubscriptions,
    ] = await Promise.all([
      countUniqueVisitors(from, to),
      countRawEvents('Lead', from, to),
      countUniqueUsersByEvent('CompleteRegistration', from, to),
      countUniqueUsersByEvent('Subscribe', from, to),
      countUniqueVisitors(prevFrom, prevTo),
      countRawEvents('Lead', prevFrom, prevTo),
      countUniqueUsersByEvent('CompleteRegistration', prevFrom, prevTo),
      countUniqueUsersByEvent('Subscribe', prevFrom, prevTo),
    ]);

    // Funnel — counts en cada etapa con conversion rates
    const funnel = {
      visitors: pageViews,
      leads,
      registrations,
      subscriptions,
      visitorsToLeadsRate: pageViews > 0 ? Math.round((leads / pageViews) * 10000) / 100 : 0,
      leadsToRegistrationsRate: leads > 0 ? Math.round((registrations / leads) * 10000) / 100 : 0,
      registrationsToSubscriptionsRate:
        registrations > 0 ? Math.round((subscriptions / registrations) * 10000) / 100 : 0,
      visitorsToSubscriptionsRate:
        pageViews > 0 ? Math.round((subscriptions / pageViews) * 10000) / 100 : 0,
    };

    // Eventos por día — serie temporal del periodo seleccionado.
    // DATE_TRUNC con AT TIME ZONE 'America/Santo_Domingo' (UTC-4) para que
    // el bucketing diario refleje el día local del negocio, no UTC.
    // Para PageView usamos COUNT(DISTINCT) — los demás eventos cuentan por user único.
    const eventsByDayRaw = await prisma.$queryRawUnsafe<
      { day: string; eventName: string; cnt: bigint }[]
    >(
      `
      SELECT
        TO_CHAR(DATE_TRUNC('day', "eventTime" AT TIME ZONE 'America/Santo_Domingo'), 'YYYY-MM-DD') as day,
        "eventName",
        CASE
          WHEN "eventName" = 'PageView' THEN COUNT(DISTINCT COALESCE("anonymousId", "userId"))::bigint
          WHEN "eventName" IN ('CompleteRegistration', 'Subscribe') THEN COUNT(DISTINCT "userId")::bigint
          ELSE COUNT(*)::bigint
        END as cnt
      FROM attribution_events
      WHERE "eventTime" >= $1 AND "eventTime" <= $2
        ${NOISE_SQL_FILTERS}
      GROUP BY day, "eventName"
      ORDER BY day ASC
      `,
      from,
      to,
    );

    // Reagrupar por día con todos los eventos como columnas
    const eventsByDayMap = new Map<
      string,
      { day: string; pageViews: number; leads: number; registrations: number; subscriptions: number }
    >();
    for (const row of eventsByDayRaw) {
      if (!eventsByDayMap.has(row.day)) {
        eventsByDayMap.set(row.day, {
          day: row.day,
          pageViews: 0,
          leads: 0,
          registrations: 0,
          subscriptions: 0,
        });
      }
      const entry = eventsByDayMap.get(row.day)!;
      const cnt = Number(row.cnt);
      if (row.eventName === 'PageView') entry.pageViews = cnt;
      else if (row.eventName === 'Lead') entry.leads = cnt;
      else if (row.eventName === 'CompleteRegistration') entry.registrations = cnt;
      else if (row.eventName === 'Subscribe') entry.subscriptions = cnt;
    }
    const eventsByDay = Array.from(eventsByDayMap.values()).sort((a, b) =>
      a.day.localeCompare(b.day),
    );

    // Top sources/campañas — agregación LIFETIME (no aplica el filtro de fechas
    // del dashboard). El usuario lo decidió así porque los costos manuales por
    // campaña no tienen granularidad temporal — mezclar costo lifetime con
    // métricas filtradas por fecha generaría CPL/CAC engañosos. Esta tabla y
    // (próximamente) sus columnas de costo viven en el mundo "totales lifetime".
    // Las demás secciones del dashboard de Adquisición SÍ siguen filtradas por
    // el rango de fechas seleccionado.
    //
    // Subscriptions/revenue: dedup por (source, campaign, userId) con MAX(value)
    // para evitar double-counting por re-deliveries del webhook de Stripe.
    // El JOIN usa `IS NOT DISTINCT FROM` para que NULL = NULL en campaña.
    // BOT FILTER: excluye eventos de HeadlessChrome (crawlers/audit bots).
    const bySourceRaw = await prisma.$queryRawUnsafe<
      {
        source: string;
        campaign: string | null;
        visitors: bigint;
        leads: bigint;
        registrations: bigint;
        subscriptions: bigint;
        revenue: number | null;
      }[]
    >(
      `
      WITH events_lifetime AS (
        SELECT
          COALESCE("source", 'Directo') as source,
          "campaign",
          "eventName",
          "userId",
          "anonymousId",
          "value"
        FROM attribution_events
        WHERE ("userAgent" IS NULL OR "userAgent" NOT ILIKE '%HeadlessChrome%')
          -- Filtra macros TikTok no resueltas (ej: __CAMPAIGN_NAME__, __AID_NAME__)
          -- que llegan literales cuando el advertiser previsualiza el ad o un bot
          -- toca la URL antes del replacement.
          AND ("campaign" IS NULL OR "campaign" NOT LIKE '\\_\\_%\\_\\_' ESCAPE '\\')
          -- Filtra macros Meta no resueltas (ej. {{campaign.name}}).
          AND ("campaign" IS NULL OR "campaign" NOT LIKE '%{{%')
          -- Filtra clicks de preview de TikTok (ttclid contiene "Preview_").
          AND ("ttclid" IS NULL OR "ttclid" NOT LIKE '%Preview\\_%' ESCAPE '\\')
      ),
      dedup_subs AS (
        SELECT source, "campaign", "userId", MAX("value") as max_value
        FROM events_lifetime
        WHERE "eventName" = 'Subscribe' AND "userId" IS NOT NULL
        GROUP BY source, "campaign", "userId"
      ),
      revenue_by_source_campaign AS (
        SELECT source, "campaign", COALESCE(SUM(max_value), 0) as revenue, COUNT(*)::bigint as subs
        FROM dedup_subs
        GROUP BY source, "campaign"
      )
      SELECT
        e.source,
        e."campaign",
        COUNT(DISTINCT CASE WHEN e."eventName" = 'PageView' THEN COALESCE(e."anonymousId", e."userId") END)::bigint as visitors,
        COUNT(CASE WHEN e."eventName" = 'Lead' THEN 1 END)::bigint as leads,
        -- Atribución por source: cada anonymousId único que disparó un Lead
        -- (click al botón "Descargar iOS/Android") cuenta como 1 user atribuido.
        -- No se usa CompleteRegistration porque ese evento se dispara desde la app
        -- mobile sin contexto de UTMs (siempre cae como source=NULL).
        COUNT(DISTINCT CASE WHEN e."eventName" = 'Lead' THEN COALESCE(e."anonymousId", e."userId") END)::bigint as registrations,
        COALESCE(rs.subs, 0)::bigint as subscriptions,
        COALESCE(rs.revenue, 0) as revenue
      FROM events_lifetime e
      LEFT JOIN revenue_by_source_campaign rs
        ON rs.source = e.source AND rs."campaign" IS NOT DISTINCT FROM e."campaign"
      GROUP BY e.source, e."campaign", rs.subs, rs.revenue
      ORDER BY visitors DESC
      `,
    );

    // Cruce con costos manuales por (source, campaña): inversión + fecha de inicio.
    // Respeta el borrado lógico (hidden) para ser consistente con la pantalla Costos.
    const acqCosts = await prisma.campaignCost.findMany();
    const costKey = (s: string, c: string | null) => `${s}::${c ?? ''}`;
    const costMap = new Map<string, { costUSD: number; campaignDate: string | null }>();
    const hiddenSet = new Set<string>();
    for (const c of acqCosts) {
      const k = costKey(c.source, c.campaign);
      costMap.set(k, {
        costUSD: Number(c.costUSD),
        campaignDate: c.campaignDate ? c.campaignDate.toISOString() : null,
      });
      if (c.hidden) hiddenSet.add(k);
    }

    const bySource = bySourceRaw
      .filter(row => !hiddenSet.has(costKey(row.source ?? 'Directo', row.campaign)))
      .map(row => {
        const visitors = Number(row.visitors);
        const registrations = Number(row.registrations);
        const cost = costMap.get(costKey(row.source ?? 'Directo', row.campaign));
        return {
          source: row.source ?? 'Directo',
          campaign: row.campaign ?? null,
          visitors,
          leads: Number(row.leads),
          registrations,
          subscriptions: Number(row.subscriptions),
          revenue: Number(row.revenue ?? 0),
          // CR% = atribuidos (Lead) / visitantes. Refleja qué % de quienes vieron
          // la landing decidieron descargar la app — métrica útil de campaña.
          conversionRate: visitors > 0 ? Math.round((registrations / visitors) * 10000) / 100 : 0,
          costUSD: cost?.costUSD ?? 0,
          campaignDate: cost?.campaignDate ?? null,
        };
      })
      .sort((a, b) => {
        // Orden por fecha de inicio desc. Las sin fecha van al final, y entre
        // ellas se mantiene el orden por visitors desc.
        if (a.campaignDate && b.campaignDate) return b.campaignDate.localeCompare(a.campaignDate);
        if (a.campaignDate) return -1;
        if (b.campaignDate) return 1;
        return b.visitors - a.visitors;
      });

    return {
      kpis: {
        pageViews,
        leads,
        registrations,
        subscriptions,
        pageViewsChange: pctChange(pageViews, prevPageViews),
        leadsChange: pctChange(leads, prevLeads),
        registrationsChange: pctChange(registrations, prevRegistrations),
        subscriptionsChange: pctChange(subscriptions, prevSubscriptions),
      },
      funnel,
      eventsByDay,
      bySource,
      cohort: {
        trackingStartDate: trackingStartDate ? trackingStartDate.toISOString() : null,
        historicalUsersCount,
      },
      period: { from: from.toISOString(), to: to.toISOString() },
    };
  }

  // ─── CAMPAIGN COSTS ──────────────────────────────────────
  // Gestión de costos manuales por (source, campaign). Sin granularidad temporal:
  // 1 fila por campaña, costo acumulado total. El listado mergea las (source,
  // campaign) que ya tienen eventos en attribution_events con las que sólo
  // existen como costo manual (sin eventos todavía).

  /**
   * Devuelve todas las (source, campaign) que tienen eventos en attribution_events
   * OR un costo ingresado manualmente. Por cada par incluye métricas lifetime
   * (visitors, leads, registros) y, si hay costo, también CPL/CAC/CPV.
   */
  static async getCampaignCosts(includeHidden = false) {
    // 1. Métricas lifetime por (source, campaign) desde attribution_events.
    //    Mismo criterio que la tabla Top Sources: filtra bots HeadlessChrome.
    //    NOTA: 'Directo' (source NULL) NO se incluye — no tiene sentido asignarle
    //    costo manual de campaña.
    const metrics = await prisma.$queryRawUnsafe<{
      source: string;
      campaign: string;
      visitors: bigint;
      leads: bigint;
      registrations: bigint;
    }[]>(
      `
      SELECT
        "source" as source,
        COALESCE("campaign", '') as campaign,
        COUNT(DISTINCT CASE WHEN "eventName" = 'PageView' THEN COALESCE("anonymousId", "userId") END)::bigint as visitors,
        COUNT(CASE WHEN "eventName" = 'Lead' THEN 1 END)::bigint as leads,
        COUNT(DISTINCT CASE WHEN "eventName" = 'Lead' THEN COALESCE("anonymousId", "userId") END)::bigint as registrations
      FROM attribution_events
      WHERE "source" IS NOT NULL
        AND ("userAgent" IS NULL OR "userAgent" NOT ILIKE '%HeadlessChrome%')
        -- Filtra macros TikTok no resueltas (__CAMPAIGN_NAME__, __AID_NAME__, etc.).
        AND ("campaign" IS NULL OR "campaign" NOT LIKE '\\_\\_%\\_\\_' ESCAPE '\\')
        -- Filtra macros Meta no resueltas (ej. {{campaign.name}}).
        AND ("campaign" IS NULL OR "campaign" NOT LIKE '%{{%')
        -- Filtra clicks de preview de TikTok (ttclid contiene "Preview_").
        AND ("ttclid" IS NULL OR "ttclid" NOT LIKE '%Preview\\_%' ESCAPE '\\')
      GROUP BY "source", COALESCE("campaign", '')
      `,
    );

    // 2. Costos manuales (todos).
    const costs = await prisma.campaignCost.findMany();

    // 3. Merge: usamos un Map para combinar por (source, campaign).
    type Row = {
      id: string | null;
      source: string;
      campaign: string;
      costUSD: number;
      notes: string | null;
      campaignDate: string | null; // ISO; solo filas con costo manual la tienen
      hidden: boolean; // borrado lógico
      visitors: number;
      leads: number;
      registrations: number;
      cpv: number | null;
      cpl: number | null;
      cac: number | null;
      hasEvents: boolean;
      isManual: boolean; // true si tiene costo pero NO tiene eventos todavía
    };

    const map = new Map<string, Row>();
    const key = (s: string, c: string) => `${s}::${c}`;

    for (const m of metrics) {
      map.set(key(m.source, m.campaign), {
        id: null,
        source: m.source,
        campaign: m.campaign,
        costUSD: 0,
        notes: null,
        campaignDate: null,
        hidden: false,
        visitors: Number(m.visitors),
        leads: Number(m.leads),
        registrations: Number(m.registrations),
        cpv: null,
        cpl: null,
        cac: null,
        hasEvents: true,
        isManual: false,
      });
    }

    for (const c of costs) {
      const k = key(c.source, c.campaign);
      const existing = map.get(k);
      const cost = Number(c.costUSD);
      if (existing) {
        existing.id = c.id;
        existing.costUSD = cost;
        existing.notes = c.notes;
        existing.campaignDate = c.campaignDate ? c.campaignDate.toISOString() : null;
        existing.hidden = c.hidden;
        existing.cpv = existing.visitors > 0 ? Math.round((cost / existing.visitors) * 100) / 100 : null;
        existing.cpl = existing.leads > 0 ? Math.round((cost / existing.leads) * 100) / 100 : null;
        existing.cac = existing.registrations > 0 ? Math.round((cost / existing.registrations) * 100) / 100 : null;
      } else {
        // Costo manual sin eventos todavía.
        map.set(k, {
          id: c.id,
          source: c.source,
          campaign: c.campaign,
          costUSD: cost,
          notes: c.notes,
          campaignDate: c.campaignDate ? c.campaignDate.toISOString() : null,
          hidden: c.hidden,
          visitors: 0,
          leads: 0,
          registrations: 0,
          cpv: null,
          cpl: null,
          cac: null,
          hasEvents: false,
          isManual: true,
        });
      }
    }

    const allRows = Array.from(map.values()).sort((a, b) => {
      // Primero las que tienen inversión, después por visitors desc.
      if (a.costUSD > 0 && b.costUSD === 0) return -1;
      if (a.costUSD === 0 && b.costUSD > 0) return 1;
      return b.visitors - a.visitors;
    });

    // Las ocultas nunca cuentan en los KPIs. La tabla las muestra solo si se pide.
    const visibleRows = allRows.filter(r => !r.hidden);
    const rows = includeHidden ? allRows : visibleRows;

    // 4. Resumen para el banner KPI (siempre sobre las visibles, no las ocultas).
    const totalInvested = visibleRows.reduce((sum, r) => sum + r.costUSD, 0);
    const totalRegistrations = visibleRows.reduce((sum, r) => sum + (r.costUSD > 0 ? r.registrations : 0), 0);
    const avgCAC = totalRegistrations > 0
      ? Math.round((totalInvested / totalRegistrations) * 100) / 100
      : null;

    return {
      rows,
      summary: {
        totalInvested: Math.round(totalInvested * 100) / 100,
        totalAttributed: totalRegistrations,
        avgCAC,
      },
    };
  }

  /**
   * Upsert de un costo por (source, campaign). Crea si no existe, actualiza si sí.
   */
  static async upsertCampaignCost(input: {
    source: string;
    campaign?: string | null;
    costUSD: number;
    notes?: string | null;
    campaignDate?: string | null;
  }) {
    const source = input.source.trim();
    if (!source) throw new Error('source es requerido');

    const campaign = (input.campaign ?? '').trim();
    const costUSD = Number(input.costUSD);
    if (!isFinite(costUSD) || costUSD < 0) {
      throw new Error('costUSD inválido (debe ser número ≥ 0)');
    }
    const notes = input.notes?.trim() || null;

    // Fecha de inicio (informativa). Acepta "YYYY-MM-DD" o ISO; "" / null la limpian.
    let campaignDate: Date | null = null;
    if (input.campaignDate) {
      const parsed = new Date(input.campaignDate);
      if (isNaN(parsed.getTime())) throw new Error('campaignDate inválida');
      campaignDate = parsed;
    }

    return prisma.campaignCost.upsert({
      where: { source_campaign: { source, campaign } },
      create: { source, campaign, costUSD, notes, campaignDate },
      update: { costUSD, notes, campaignDate },
    });
  }

  /**
   * Borra un costo manual por id.
   */
  static async deleteCampaignCost(id: string) {
    return prisma.campaignCost.delete({ where: { id } });
  }

  /**
   * Oculta/restaura una campaña (borrado lógico) por (source, campaign).
   * Si la campaña solo existe como tráfico (sin costo manual), crea una fila
   * marcadora con costo 0. Si ya tiene costo, solo cambia el flag (lo preserva).
   */
  static async setCampaignHidden(input: {
    source: string;
    campaign?: string | null;
    hidden: boolean;
  }) {
    const source = input.source.trim();
    if (!source) throw new Error('source es requerido');
    const campaign = (input.campaign ?? '').trim();

    return prisma.campaignCost.upsert({
      where: { source_campaign: { source, campaign } },
      create: { source, campaign, costUSD: 0, hidden: input.hidden },
      update: { hidden: input.hidden },
    });
  }
}
