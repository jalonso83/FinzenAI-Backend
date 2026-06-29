import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { logger } from '../utils/logger';
import { userBucket } from '../lib/userBucket';

// Experimento H10 — "Entrada libre" (onboarding no bloqueante).
// Mide variante (entra sin muro) vs control (ve el muro) sobre la cohorte de
// usuarios NUEVOS, reusando EXACTAMENTE el mismo userBucket que decide quién entra
// (cero riesgo de que el split del análisis difiera del split real).
const FEATURE = 'onboarding-nonblocking';
const ACTIVATION_WINDOW_DAYS = 7;
const ROLLBACK_THRESHOLD_PTS = 3; // si la activación de la variante cae ≥3 pts vs control

/**
 * GET /api/admin/experiments/h10/stats?from=ISO&to=ISO
 * Compara variante (bucket < PCT) vs control (bucket >= PCT):
 *  - Tasa de entrada (firstAppEntryAt != null) — chequeo de mecanismo.
 *  - Activación (≥1 tx válida, monto>0, en 7d desde el registro) — métrica de decisión.
 * La medición solo es válida para usuarios registrados DESDE que se prendió el flag.
 */
export const getH10Stats = async (req: Request, res: Response) => {
  try {
    const enabled = process.env.ONBOARDING_NONBLOCKING_ENABLED === 'true';
    const pctRaw = parseInt(process.env.ONBOARDING_NONBLOCKING_ROLLOUT_PCT || '0', 10);
    const pct = Number.isFinite(pctRaw) ? Math.max(0, Math.min(100, pctRaw)) : 0;
    const whitelistArr = (process.env.ONBOARDING_NONBLOCKING_WHITELIST || '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    const whitelist = new Set(whitelistArr);

    // Inicio del experimento AUTO-DETECTADO: el PRIMER MOMENTO en que alguien entró
    // de verdad por el camino 'nonblocking' (firstAppEntryAt más antiguo), excluyendo
    // la whitelist de QA. OJO: se ancla por `firstAppEntryAt`, NO por `createdAt` —
    // un usuario viejo que nunca completó onboarding y entra ahora por la variante
    // recibe `onboardingMethod='nonblocking'` con un `createdAt` antiguo; anclar por
    // su registro arrastraría semanas de usuarios pre-experimento a la cohorte e
    // inflaría/diluiría el resultado. `firstAppEntryAt` marca cuándo ocurrió el
    // tratamiento (≈ flag+build vivos). La cohorte (`createdAt >= experimentStart`)
    // excluye así a ese usuario viejo y a todo lo pre-experimento. Si todavía no hay
    // ningún 'nonblocking' (flag apagado o nadie entró aún) → null.
    const firstNB = await prisma.user.findFirst({
      where: {
        onboardingMethod: 'nonblocking',
        firstAppEntryAt: { not: null },
        ...(whitelistArr.length ? { id: { notIn: whitelistArr } } : {}),
      },
      orderBy: { firstAppEntryAt: 'asc' },
      select: { firstAppEntryAt: true },
    });
    const experimentStart = firstNB?.firstAppEntryAt ?? null;

    let from = req.query.from ? new Date(String(req.query.from)) : null;
    if (from && isNaN(from.getTime())) from = null;
    let to = req.query.to ? new Date(String(req.query.to)) : new Date();
    if (isNaN(to.getTime())) to = new Date();

    // La cohorte arranca en el MÁS TARDÍO entre el período pedido y el inicio del flag.
    let effectiveFrom = from;
    if (experimentStart && (!effectiveFrom || effectiveFrom < experimentStart)) {
      effectiveFrom = experimentStart;
    }

    const where: any = { createdAt: effectiveFrom ? { gte: effectiveFrom, lte: to } : { lte: to } };
    const users = await prisma.user.findMany({
      where,
      select: { id: true, createdAt: true, firstAppEntryAt: true },
    });

    // Excluir whitelist (QA/dogfood no es asignación aleatoria).
    const cohort = users.filter((u) => !whitelist.has(u.id));
    const cohortIds = cohort.map((u) => u.id);

    // Activación: primera transacción válida (monto > 0) por usuario. Usamos
    // `createdAt` (cuándo la registró en la app), no `date` (fecha contable que el
    // usuario puede backdatear) — el createdAt es la señal real de "actuó".
    const txs = cohortIds.length
      ? await prisma.transaction.findMany({
          where: { userId: { in: cohortIds }, amount: { gt: 0 } },
          select: { userId: true, createdAt: true },
        })
      : [];
    const firstTx = new Map<string, Date>();
    for (const t of txs) {
      const prev = firstTx.get(t.userId);
      if (!prev || t.createdAt < prev) firstTx.set(t.userId, t.createdAt);
    }

    const armOf = (id: string): 'variant' | 'control' =>
      userBucket(id, FEATURE) < pct ? 'variant' : 'control';
    const acc = {
      variant: { n: 0, entered: 0, activated: 0 },
      control: { n: 0, entered: 0, activated: 0 },
    };
    const WINDOW_MS = ACTIVATION_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    for (const u of cohort) {
      const g = acc[armOf(u.id)];
      g.n++;
      if (u.firstAppEntryAt) g.entered++;
      const ft = firstTx.get(u.id);
      if (ft && ft.getTime() <= u.createdAt.getTime() + WINDOW_MS) g.activated++;
    }

    const rate = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 10000) / 100 : 0);
    const build = (g: { n: number; entered: number; activated: number }) => ({
      n: g.n,
      entered: g.entered,
      enteredRate: rate(g.entered, g.n),
      activated: g.activated,
      activationRate: rate(g.activated, g.n),
    });
    const variant = build(acc.variant);
    const control = build(acc.control);
    const activationLiftPts = Math.round((variant.activationRate - control.activationRate) * 100) / 100;

    return res.json({
      data: {
        enabled,
        pct,
        from: effectiveFrom ? effectiveFrom.toISOString() : null,
        to: to.toISOString(),
        experimentStart: experimentStart ? experimentStart.toISOString() : null,
        activationWindowDays: ACTIVATION_WINDOW_DAYS,
        rollbackThresholdPts: ROLLBACK_THRESHOLD_PTS,
        // El daño dispara rollback si la variante cae ≥ umbral vs control.
        rollbackTriggered: activationLiftPts <= -ROLLBACK_THRESHOLD_PTS,
        variant,
        control,
        activationLiftPts,
        entryLiftPts: Math.round((variant.enteredRate - control.enteredRate) * 100) / 100,
      },
    });
  } catch (error) {
    logger.error('[Experiments] Error H10 stats:', error);
    return res.status(500).json({ message: 'Error calculando métricas del experimento', error: 'Internal server error' });
  }
};
