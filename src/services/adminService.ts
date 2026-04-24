import { prisma } from '../lib/prisma';
import { Prisma } from '@prisma/client';
import { PLAN_PRICES } from '../config/adminConfig';
import { getPlanFromPriceId, PLANS } from '../config/stripe';
import { logger } from '../utils/logger';

interface UsersListQuery {
  page?: string;
  limit?: string;
  search?: string;
  plan?: string;
  status?: string;
  country?: string;
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

export class AdminService {
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
      trialToPaidCount,
      totalTrialEnded,
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

      // Activated users (onboarding completed)
      prisma.user.count({
        where: { onboardingCompleted: true },
      }),

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

      // Churn: subscriptions canceled in period
      prisma.subscription.count({
        where: {
          status: 'CANCELED',
          updatedAt: { gte: from, lte: to },
          plan: { not: 'FREE' },
        },
      }),

      // Active paid subs at start of period (for churn rate denominator)
      prisma.subscription.count({
        where: {
          plan: { not: 'FREE' },
          status: { in: ['ACTIVE', 'TRIALING'] },
          createdAt: { lt: from },
        },
      }),

      // DAU: distinct users with gamification events today
      prisma.gamificationEvent.findMany({
        where: { createdAt: { gte: from, lte: to } },
        distinct: ['userId'],
        select: { userId: true, createdAt: true },
      }),

      // MAU: distinct users with gamification events last 30 days
      prisma.gamificationEvent.findMany({
        where: {
          createdAt: {
            gte: new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000),
            lte: to,
          },
        },
        distinct: ['userId'],
        select: { userId: true },
      }),

      // Trial to paid conversions in period
      prisma.subscription.count({
        where: {
          plan: { not: 'FREE' },
          status: 'ACTIVE',
          trialEndsAt: { not: null, gte: from, lte: to },
        },
      }),

      // Total trials that ended in period
      prisma.subscription.count({
        where: {
          trialEndsAt: { gte: from, lte: to },
        },
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

      // Retention D1: users who had activity 1 day after registration
      prisma.$queryRawUnsafe<{ cnt: bigint }[]>(`
        SELECT COUNT(DISTINCT u.id)::bigint as cnt FROM users u
        JOIN gamification_events ge ON ge."userId" = u.id
        WHERE u."createdAt" >= $1 AND u."createdAt" <= $2
          AND ge."createdAt" >= u."createdAt" + interval '1 day'
          AND ge."createdAt" < u."createdAt" + interval '2 days'
      `, from, to),

      // Retention D7
      prisma.$queryRawUnsafe<{ cnt: bigint }[]>(`
        SELECT COUNT(DISTINCT u.id)::bigint as cnt FROM users u
        JOIN gamification_events ge ON ge."userId" = u.id
        WHERE u."createdAt" >= $1 AND u."createdAt" <= $2
          AND ge."createdAt" >= u."createdAt" + interval '7 days'
          AND ge."createdAt" < u."createdAt" + interval '8 days'
      `, from, to),

      // Retention D30
      prisma.$queryRawUnsafe<{ cnt: bigint }[]>(`
        SELECT COUNT(DISTINCT u.id)::bigint as cnt FROM users u
        JOIN gamification_events ge ON ge."userId" = u.id
        WHERE u."createdAt" >= $1 AND u."createdAt" <= $2
          AND ge."createdAt" >= u."createdAt" + interval '30 days'
          AND ge."createdAt" < u."createdAt" + interval '31 days'
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

    // DAU: compute average daily unique users
    const dauByDay = new Map<string, Set<string>>();
    dauRaw.forEach(e => {
      const day = e.createdAt.toISOString().slice(0, 10);
      if (!dauByDay.has(day)) dauByDay.set(day, new Set());
      dauByDay.get(day)!.add(e.userId);
    });
    const dauValues = Array.from(dauByDay.values()).map(s => s.size);
    const dauAvg = dauValues.length > 0
      ? Math.round(dauValues.reduce((a, b) => a + b, 0) / dauValues.length)
      : 0;
    const mau = mauRaw.length;

    const churnRate = activeStartOfPeriod > 0
      ? Math.round((churnedCount / activeStartOfPeriod) * 10000) / 100
      : 0;

    const trialToPaidRate = totalTrialEnded > 0
      ? Math.round((trialToPaidCount / totalTrialEnded) * 10000) / 100
      : 0;

    const freeToPaidRate = totalFreeUsers > 0
      ? Math.round((freeToPaidCount / totalFreeUsers) * 10000) / 100
      : 0;

    const d1 = retentionD1Data[0] ? Number(retentionD1Data[0].cnt) : 0;
    const d7 = retentionD7Data[0] ? Number(retentionD7Data[0].cnt) : 0;
    const d30 = retentionD30Data[0] ? Number(retentionD30Data[0].cnt) : 0;

    return {
      totalUsers,
      newRegistrations,
      registrationChange: pctChange(newRegistrations, prevRegistrations),
      activatedUsers,
      planDistribution: planCounts,
      churnRate,
      trialsActive,
      mrrEstimated: Math.round(mrrEstimated * 100) / 100,
      dau: dauAvg,
      mau,
      trialToPaidRate,
      freeToPaidRate,
      retentionD1: newRegistrations > 0 ? Math.round((d1 / newRegistrations) * 10000) / 100 : 0,
      retentionD7: newRegistrations > 0 ? Math.round((d7 / newRegistrations) * 10000) / 100 : 0,
      retentionD30: newRegistrations > 0 ? Math.round((d30 / newRegistrations) * 10000) / 100 : 0,
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

      // Funnel: D1 retained
      prisma.$queryRawUnsafe<{ cnt: bigint }[]>(`
        SELECT COUNT(DISTINCT u.id)::bigint as cnt FROM users u
        JOIN gamification_events ge ON ge."userId" = u.id
        WHERE u."createdAt" >= $1 AND u."createdAt" <= $2
          AND ge."createdAt" >= u."createdAt" + interval '1 day'
          AND ge."createdAt" < u."createdAt" + interval '2 days'
      `, from, to),

      // Funnel: D7 retained
      prisma.$queryRawUnsafe<{ cnt: bigint }[]>(`
        SELECT COUNT(DISTINCT u.id)::bigint as cnt FROM users u
        JOIN gamification_events ge ON ge."userId" = u.id
        WHERE u."createdAt" >= $1 AND u."createdAt" <= $2
          AND ge."createdAt" >= u."createdAt" + interval '7 days'
          AND ge."createdAt" < u."createdAt" + interval '8 days'
      `, from, to),

      // Funnel: started trial
      prisma.subscription.count({
        where: {
          trialStartedAt: { gte: from, lte: to },
        },
      }),

      // Funnel: converted to paid
      prisma.subscription.count({
        where: {
          plan: { not: 'FREE' },
          status: 'ACTIVE',
          createdAt: { gte: from, lte: to },
        },
      }),
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
          AND ge."createdAt" < c.cohort_week + interval '2 days' THEN c.id END)::bigint as d1,
        COUNT(DISTINCT CASE WHEN ge."createdAt" >= c.cohort_week + interval '7 days'
          AND ge."createdAt" < c.cohort_week + interval '8 days' THEN c.id END)::bigint as d7,
        COUNT(DISTINCT CASE WHEN ge."createdAt" >= c.cohort_week + interval '14 days'
          AND ge."createdAt" < c.cohort_week + interval '15 days' THEN c.id END)::bigint as d14,
        COUNT(DISTINCT CASE WHEN ge."createdAt" >= c.cohort_week + interval '30 days'
          AND ge."createdAt" < c.cohort_week + interval '31 days' THEN c.id END)::bigint as d30
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
        trialStarted: totalTrialStarted,
        paid: totalPaid,
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
      trialToPaidCount,
      totalTrialEnded,
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

      // Cancellations in last 30 days
      prisma.subscription.count({
        where: {
          status: 'CANCELED',
          updatedAt: { gte: thirtyDaysAgo, lte: to },
          plan: { not: 'FREE' },
        },
      }),

      // Trial to paid conversions
      prisma.subscription.count({
        where: {
          plan: { not: 'FREE' },
          status: 'ACTIVE',
          trialEndsAt: { not: null, gte: from, lte: to },
        },
      }),

      // Total trials ended in period
      prisma.subscription.count({
        where: {
          trialEndsAt: { gte: from, lte: to },
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

      // Revenue from Stripe (paymentProvider = STRIPE)
      prisma.$queryRawUnsafe<{ total: string | null }[]>(`
        SELECT SUM(p.amount) as total
        FROM payments p
        JOIN subscriptions s ON p."subscriptionId" = s.id
        WHERE p.status = 'SUCCEEDED'
          AND p."createdAt" >= $1
          AND p."createdAt" <= $2
          AND s."paymentProvider" = 'STRIPE'
      `, from, to),

      // Revenue from RevenueCat/Apple (paymentProvider = APPLE)
      prisma.$queryRawUnsafe<{ total: string | null }[]>(`
        SELECT SUM(p.amount) as total
        FROM payments p
        JOIN subscriptions s ON p."subscriptionId" = s.id
        WHERE p.status = 'SUCCEEDED'
          AND p."createdAt" >= $1
          AND p."createdAt" <= $2
          AND s."paymentProvider" = 'APPLE'
      `, from, to),
    ]);

    // Calculate MRR from active subscriptions, normalized for billing period
    let mrrCurrent = 0;
    const currentMrrObj: Record<string, number> = { PREMIUM: 0, PRO: 0 };

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

    const trialToPaidRate = totalTrialEnded > 0
      ? Math.round((trialToPaidCount / totalTrialEnded) * 10000) / 100
      : 0;

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
      trialsActive,
      cancellations30d,
      trialToPaidRate,
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
        stripe: Math.round((parseFloat(stripeRevenueTotal[0]?.total || '0')) * 100) / 100,
        revenuecat: Math.round((parseFloat(revenuecatRevenueTotal[0]?.total || '0')) * 100) / 100,
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
      zenioSessions,
      referralsMade,
      referralsConverted,
      registrationsByChannel,
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

      // Zenio sessions (sum of zenioQueriesUsed)
      prisma.subscription.aggregate({
        _sum: { zenioQueriesUsed: true },
      }),

      // Referrals made in period
      prisma.referral.count({
        where: { createdAt: { gte: from, lte: to } },
      }),

      // Referrals converted in period
      prisma.referral.count({
        where: { status: 'CONVERTED', convertedAt: { gte: from, lte: to } },
      }),

      // Registrations by country (as channel proxy)
      prisma.user.groupBy({
        by: ['country'],
        _count: { country: true },
        where: { createdAt: { gte: from, lte: to } },
        orderBy: { _count: { country: 'desc' } },
        take: 10,
      }),
    ]);

    const activeUsers = Number(activeUsersWithTx[0]?.cnt ?? 0);
    const transactionsPerActiveUser = activeUsers > 0
      ? Math.round((totalTransactions / activeUsers) * 100) / 100
      : 0;

    const onboardingRate = totalUsers > 0
      ? Math.round((totalOnboarded / totalUsers) * 10000) / 100
      : 0;

    return {
      transactionsPerActiveUser,
      totalTransactions,
      activeUsers,
      onboardingRate,
      zenioTotalQueries: zenioSessions._sum.zenioQueriesUsed || 0,
      referrals: {
        total: referralsMade,
        converted: referralsConverted,
      },
      registrationsByChannel: registrationsByChannel.map(r => ({
        country: r.country,
        count: r._count.country,
      })),
      period: { from, to },
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

    const mappedUsers = users.map(u => ({
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
    }));

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
}
