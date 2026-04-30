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

      // Churn (revenue-based): users that paid in the previous period of the
      // same length, but did NOT pay in the current period. This is independent
      // of subscription.status — true churn is when money stops coming in.
      prisma.$queryRawUnsafe<{ cnt: bigint }[]>(`
        SELECT COUNT(DISTINCT prev."userId")::bigint as cnt
        FROM payments prev
        WHERE prev.status = 'SUCCEEDED'
          AND prev."createdAt" >= $1 AND prev."createdAt" <= $2
          AND NOT EXISTS (
            SELECT 1 FROM payments curr
            WHERE curr."userId" = prev."userId"
              AND curr.status = 'SUCCEEDED'
              AND curr."createdAt" >= $3 AND curr."createdAt" <= $4
          )
      `, prevFrom, prevTo, from, to),

      // Churn denominator: users that paid in the previous period (the base
      // we measure attrition against).
      prisma.$queryRawUnsafe<{ cnt: bigint }[]>(`
        SELECT COUNT(DISTINCT "userId")::bigint as cnt
        FROM payments
        WHERE status = 'SUCCEEDED'
          AND "createdAt" >= $1 AND "createdAt" <= $2
      `, prevFrom, prevTo),

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
    const activeStartOfPeriodNum = Number(activeStartOfPeriod[0]?.cnt ?? 0);
    const churnRate = activeStartOfPeriodNum > 0
      ? Math.round((churnedCountNum / activeStartOfPeriodNum) * 10000) / 100
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

    return {
      totalUsers,
      newRegistrations,
      registrationChange: pctChange(newRegistrations, prevRegistrations),
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
      totalOnboarded,
      totalActivated,
      retainedD1,
      retainedD7,
      totalTrialStarted,
      totalPaid,
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
      `, from, to),

      // Funnel: D7 retained — same fix.
      prisma.$queryRawUnsafe<{ cnt: bigint }[]>(`
        SELECT COUNT(DISTINCT u.id)::bigint as cnt FROM users u
        JOIN gamification_events ge ON ge."userId" = u.id
        WHERE u."createdAt" >= $1
          AND u."createdAt" <= LEAST($2::timestamp, NOW() - interval '7 days')
          AND ge."createdAt" >= u."createdAt" + interval '7 days'
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
    ]);

    // Cohort analysis: weekly retention
    const cohorts = await prisma.$queryRawUnsafe<{
      cohort_week: string;
      cohort_size: bigint;
      d1: bigint;
      d7: bigint;
      d14: bigint;
      d30: bigint;
    }[]>(`
      WITH cohort AS (
        SELECT id, DATE_TRUNC('week', "createdAt") as cohort_week
        FROM users
        WHERE "createdAt" >= $1 AND "createdAt" <= $2
      )
      SELECT
        c.cohort_week::text as cohort_week,
        COUNT(DISTINCT c.id)::bigint as cohort_size,
        COUNT(DISTINCT CASE WHEN ge."createdAt" >= c.cohort_week + interval '1 day'
          THEN c.id END)::bigint as d1,
        COUNT(DISTINCT CASE WHEN ge."createdAt" >= c.cohort_week + interval '7 days'
          THEN c.id END)::bigint as d7,
        COUNT(DISTINCT CASE WHEN ge."createdAt" >= c.cohort_week + interval '14 days'
          THEN c.id END)::bigint as d14,
        COUNT(DISTINCT CASE WHEN ge."createdAt" >= c.cohort_week + interval '30 days'
          THEN c.id END)::bigint as d30
      FROM cohort c
      LEFT JOIN gamification_events ge ON ge."userId" = c.id
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
        onboarded: totalOnboarded,
        activated: Number(totalActivated[0]?.cnt ?? 0),
        retainedD1: activated,
        retainedD7: retainedD7[0] ? Number(retainedD7[0].cnt) : 0,
        trialStarted: Number(totalTrialStarted[0]?.cnt ?? 0),
        paid: Number(totalPaid[0]?.cnt ?? 0),
      },
      cohorts: cohorts.map(c => ({
        week: c.cohort_week,
        size: Number(c.cohort_size),
        d1: Number(c.d1),
        d7: Number(c.d7),
        d14: Number(c.d14),
        d30: Number(c.d30),
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

      // Cancellations (revenue-based, last 30 days):
      // users that paid in [thirtyDaysAgo - 30d, thirtyDaysAgo] but did NOT pay in
      // [thirtyDaysAgo, to]. Status-independent; reflects real attrition.
      prisma.$queryRawUnsafe<{ cnt: bigint }[]>(`
        SELECT COUNT(DISTINCT prev."userId")::bigint as cnt
        FROM payments prev
        WHERE prev.status = 'SUCCEEDED'
          AND prev."createdAt" >= $1 AND prev."createdAt" < $2
          AND NOT EXISTS (
            SELECT 1 FROM payments curr
            WHERE curr."userId" = prev."userId"
              AND curr.status = 'SUCCEEDED'
              AND curr."createdAt" >= $2 AND curr."createdAt" <= $3
          )
      `, new Date(thirtyDaysAgo.getTime() - 30 * 24 * 60 * 60 * 1000), thirtyDaysAgo, to),

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
      cancellations30d: Number(cancellations30d[0]?.cnt ?? 0),
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
      prisma.referral.count({
        where: {
          createdAt: { gte: from, lte: to },
          status: 'CONVERTED',
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

      // Users with active daily streak in period.
      // Active = currentStreak > 0 AND lastActivityDate touched the period.
      prisma.$queryRawUnsafe<{ cnt: bigint }[]>(`
        SELECT COUNT(DISTINCT "userId")::bigint as cnt
        FROM user_streaks
        WHERE "currentStreak" > 0
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

    // % Adopción Zenio: cap at 100 to handle edge case of Zenio users without tx
    const zenioAdoptionRate = activeUsers > 0
      ? Math.min(Math.round((zenioActiveUsers / activeUsers) * 10000) / 100, 100)
      : 0;

    // % Racha Activa
    const streakActiveUsers = Number(streakActiveUsersData[0]?.cnt ?? 0);
    const streakActiveRate = activeUsers > 0
      ? Math.round((streakActiveUsers / activeUsers) * 10000) / 100
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
      streakActiveUsers,
      streakActiveRate,
      timeToFirstTx,
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

    if (status && ['NO_VERIFICADO', 'SIN_ONBOARDING', 'EN_TRIAL', 'ACTIVO', 'CANCELADO'].includes(status)) {
      let filter: any;
      const now = new Date();

      if (status === 'NO_VERIFICADO') {
        filter = { verified: false };
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
        filter = { subscription: { status: 'CANCELLED' } };
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

    // Calcular trackingStartDate ANTES del query principal — necesario para
    // poder filtrar por cohort dentro del where.
    const trackingStartDate = await AdminService.getTrackingStartDate();

    // Filtro por cohort (debe agregarse al where ANTES del findMany).
    // Lógica:
    //   'Histórico'  → createdAt < trackingStartDate (o todos si no hay tracking)
    //   'Directo'    → createdAt >= trackingStartDate Y (sin fila attribution O firstTouchSource null/'')
    //   'Atribuido'  → createdAt >= trackingStartDate Y attribution.firstTouchSource no-null Y no-''
    //
    // CRÍTICO: en Prisma, `attribution: { firstTouchSource: null }` SOLO matchea users
    // que TIENEN fila de attribution con source null. Para users SIN fila usar
    // `attribution: { is: null }`. Por eso 'Directo' debe incluir AMBOS casos via OR.
    const cohortFilter = query.cohort?.trim();
    if (cohortFilter && ['Histórico', 'Directo', 'Atribuido'].includes(cohortFilter)) {
      let cohortClause: Prisma.UserWhereInput | null = null;

      if (cohortFilter === 'Histórico') {
        // Si no hay tracking, todos los users son históricos → sin filtro adicional
        cohortClause = trackingStartDate
          ? { createdAt: { lt: trackingStartDate } }
          : {};
      } else if (cohortFilter === 'Directo') {
        if (!trackingStartDate) {
          cohortClause = { id: '__no_match__' };
        } else {
          cohortClause = {
            AND: [
              { createdAt: { gte: trackingStartDate } },
              {
                OR: [
                  { attribution: { is: null } },                       // sin fila de attribution
                  { attribution: { firstTouchSource: null } },         // con fila pero source null
                  { attribution: { firstTouchSource: '' } },           // con fila pero source vacío
                ],
              },
            ],
          };
        }
      } else if (cohortFilter === 'Atribuido') {
        if (!trackingStartDate) {
          cohortClause = { id: '__no_match__' };
        } else {
          cohortClause = {
            AND: [
              { createdAt: { gte: trackingStartDate } },
              { attribution: { firstTouchSource: { not: null } } },
              { attribution: { firstTouchSource: { not: '' } } },
            ],
          };
        }
      }

      // Combinamos con AND para no romper otros filtros (status, plan, country, etc.)
      if (cohortClause && Object.keys(cohortClause).length > 0) {
        const existingAnd = (where.AND as Prisma.UserWhereInput[] | undefined) ?? [];
        where.AND = [...existingAnd, cohortClause];
      }
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
            },
          },
          attribution: {
            select: {
              firstTouchSource: true,
            },
          },
          _count: {
            select: {
              transactions: true,
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

    if (userIds.length > 0) {
      const lastActivities = await prisma.$queryRawUnsafe<
        { userId: string; lastActivity: Date }[]
      >(
        `SELECT "userId", MAX("createdAt") as "lastActivity"
         FROM gamification_events
         WHERE "userId" = ANY($1::text[])
         GROUP BY "userId"`,
        userIds
      );
      lastActivities.forEach(a => {
        lastActivityMap[a.userId] = a.lastActivity;
      });
    }

    // Cohort dinámico (3 valores en español):
    //   'Histórico'  — createdAt < trackingStartDate (registrado antes del tracking)
    //   'Directo'    — registrado después del tracking, sin firstTouchSource
    //   'Atribuido'  — registrado después del tracking, con firstTouchSource conocido
    // trackingStartDate ya fue calculado arriba (antes del findMany para soportar filtro).
    const mappedUsers = users.map(u => {
      let cohort: 'Histórico' | 'Directo' | 'Atribuido';
      if (!trackingStartDate || u.createdAt < trackingStartDate) {
        cohort = 'Histórico';
      } else if (u.attribution?.firstTouchSource) {
        cohort = 'Atribuido';
      } else {
        cohort = 'Directo';
      }
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
    const countRawEvents = (eventName: string, rangeFrom: Date, rangeTo: Date) =>
      prisma.attributionEvent.count({
        where: { eventName, eventTime: { gte: rangeFrom, lte: rangeTo } },
      });

    const countUniqueVisitors = async (rangeFrom: Date, rangeTo: Date): Promise<number> => {
      const result = await prisma.$queryRawUnsafe<{ cnt: bigint }[]>(
        `SELECT COUNT(DISTINCT COALESCE("anonymousId", "userId"))::bigint as cnt
         FROM attribution_events
         WHERE "eventName" = 'PageView'
           AND "eventTime" >= $1 AND "eventTime" <= $2`,
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
           AND "eventTime" >= $2 AND "eventTime" <= $3`,
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

    // Top sources — agregación por source de attribution_events.
    // Subscriptions y registrations son DISTINCT por userId (1 user = 1 conversión).
    // Revenue: para evitar double counting por re-deliveries de webhook,
    // se dedupea por (source, userId) tomando MAX(value) — luego se suma.
    const bySourceRaw = await prisma.$queryRawUnsafe<
      {
        source: string;
        visitors: bigint;
        leads: bigint;
        registrations: bigint;
        subscriptions: bigint;
        revenue: number | null;
      }[]
    >(
      `
      WITH events_in_period AS (
        SELECT
          COALESCE("source", 'Directo') as source,
          "eventName",
          "userId",
          "anonymousId",
          "value"
        FROM attribution_events
        WHERE "eventTime" >= $1 AND "eventTime" <= $2
      ),
      dedup_subs AS (
        SELECT source, "userId", MAX("value") as max_value
        FROM events_in_period
        WHERE "eventName" = 'Subscribe' AND "userId" IS NOT NULL
        GROUP BY source, "userId"
      ),
      revenue_by_source AS (
        SELECT source, COALESCE(SUM(max_value), 0) as revenue, COUNT(*)::bigint as subs
        FROM dedup_subs
        GROUP BY source
      )
      SELECT
        e.source,
        COUNT(DISTINCT CASE WHEN e."eventName" = 'PageView' THEN COALESCE(e."anonymousId", e."userId") END)::bigint as visitors,
        COUNT(CASE WHEN e."eventName" = 'Lead' THEN 1 END)::bigint as leads,
        COUNT(DISTINCT CASE WHEN e."eventName" = 'CompleteRegistration' THEN e."userId" END)::bigint as registrations,
        COALESCE(rs.subs, 0)::bigint as subscriptions,
        COALESCE(rs.revenue, 0) as revenue
      FROM events_in_period e
      LEFT JOIN revenue_by_source rs ON rs.source = e.source
      GROUP BY e.source, rs.subs, rs.revenue
      ORDER BY visitors DESC
      `,
      from,
      to,
    );

    const bySource = bySourceRaw.map(row => {
      const visitors = Number(row.visitors);
      const subscriptions = Number(row.subscriptions);
      return {
        source: row.source ?? 'Directo',
        visitors,
        leads: Number(row.leads),
        registrations: Number(row.registrations),
        subscriptions,
        revenue: Number(row.revenue ?? 0),
        conversionRate: visitors > 0 ? Math.round((subscriptions / visitors) * 10000) / 100 : 0,
      };
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
}
