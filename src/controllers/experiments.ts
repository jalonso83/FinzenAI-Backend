import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { logger } from '../utils/logger';
import { userBucket } from '../lib/userBucket';
import { getExperimentStart } from '../lib/experimentStart';
import { isH13FlagOn, isH13Whitelisted } from '../config/h13';
import {
  H13_KEY,
  H13_TARGET_DAYS,
  H13_WINDOW_DAYS,
  h13WindowDayKeys,
  h13WindowEnd,
  localDateKey,
} from '../services/h13/h13Service';

// Experimento H10 — "Entrada libre" (onboarding no bloqueante).
// Mide variante (entra sin muro) vs control (ve el muro) sobre la cohorte de
// usuarios NUEVOS, reusando EXACTAMENTE el mismo userBucket que decide quién entra
// (cero riesgo de que el split del análisis difiera del split real).
const FEATURE = 'onboarding-nonblocking';
const ACTIVATION_WINDOW_DAYS = 7;
const ROLLBACK_THRESHOLD_PTS = 3; // si la activación de la variante cae ≥3 pts vs control
// Muestra mínima por brazo antes de mostrar veredicto (rollback / no-inferioridad).
// Por debajo, cualquier "lift" es ruido (ej. 1 vs 1 da ±100 pts sin significar nada).
const MIN_SAMPLE_PER_ARM = 30;

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

    // Inicio del experimento: se lee de la tabla `experiments` (auto-estampado la
    // primera vez que el flag se vio live; ver lib/experimentStart). NO env var, NO
    // auto-detect sobre datos de usuarios. Si todavía no está estampado → null y NO
    // se mide (cohorte vacía + aviso), para no inflar con pre-experimento.
    const experimentStart = await getExperimentStart(FEATURE);

    let from = req.query.from ? new Date(String(req.query.from)) : null;
    if (from && isNaN(from.getTime())) from = null;
    let to = req.query.to ? new Date(String(req.query.to)) : new Date();
    if (isNaN(to.getTime())) to = new Date();
    // `to` llega como 'YYYY-MM-DD' → new Date() lo pone a las 00:00 (inicio del día),
    // lo que se comía TODO el día final (ej. los registros de hoy). Lo llevamos al
    // final del día para incluirlo completo.
    to.setUTCHours(23, 59, 59, 999);

    // La cohorte arranca SIEMPRE en el inicio explícito del experimento. Si el período
    // pedido (from) es más tardío, se respeta el más tardío. Sin experimentStart no
    // hay cohorte (no medimos pre-experimento).
    let effectiveFrom = experimentStart;
    if (from && experimentStart && from > experimentStart) effectiveFrom = from;

    const users = experimentStart
      ? await prisma.user.findMany({
          where: { createdAt: { gte: effectiveFrom as Date, lte: to } },
          select: { id: true, createdAt: true, firstAppEntryAt: true },
        })
      : [];

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

    // Guard de muestra mínima: sin suficiente n por brazo, NO se emite veredicto
    // (rollback ni no-inferioridad) — el lift es ruido. El frontend muestra
    // "acumulando muestra" en gris en vez de rojo/verde.
    const sufficientSample = variant.n >= MIN_SAMPLE_PER_ARM && control.n >= MIN_SAMPLE_PER_ARM;

    return res.json({
      data: {
        enabled,
        pct,
        from: effectiveFrom ? effectiveFrom.toISOString() : null,
        to: to.toISOString(),
        experimentStart: experimentStart ? experimentStart.toISOString() : null,
        activationWindowDays: ACTIVATION_WINDOW_DAYS,
        rollbackThresholdPts: ROLLBACK_THRESHOLD_PTS,
        minSamplePerArm: MIN_SAMPLE_PER_ARM,
        sufficientSample,
        // El rollback SOLO se declara con muestra suficiente (si no, es ruido).
        rollbackTriggered: sufficientSample && activationLiftPts <= -ROLLBACK_THRESHOLD_PTS,
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

// ─────────────────────────────────────────────────────────────────────────
// Experimento H13 — "Reto de la Primera Semana".
//
// Métrica primaria (paquete de implementación, 21-jul): % de asignados con ≥3
// días distintos con TX válida en la ventana de 7 días, POR BRAZO. Los dos
// brazos se calculan desde la tabla de transacciones — el control no tiene
// eventos del flujo, solo su fila de asignación.
//
// La cohorte sale de experiment_participants: en H13 el enrolamiento ocurre en
// la 1ª TX válida, así que la fila ES la cohorte (a diferencia de H10, que parte
// de usuarios registrados).
// ─────────────────────────────────────────────────────────────────────────

// Muestra mínima por brazo antes de emitir veredicto (mismo criterio que H10:
// por debajo, cualquier lift es ruido).
const H13_MIN_SAMPLE_PER_ARM = 30;

/**
 * GET /api/admin/experiments/h13/stats?from=ISO&to=ISO
 *
 * Clave metodológica: la primaria se calcula SOLO sobre participantes cuya
 * ventana de 7 días ya cerró ("maduros"). Incluir a quien lleva 2 días dentro
 * del reto lo cuenta como fracaso cuando todavía le quedan 5 días, y hunde la
 * tasa de los dos brazos — más al reto, que es el que sigue recibiendo gente.
 */
export const getH13Stats = async (req: Request, res: Response) => {
  try {
    const enabled = isH13FlagOn();
    const experimentStart = await getExperimentStart(H13_KEY);

    let from = req.query.from ? new Date(String(req.query.from)) : null;
    if (from && isNaN(from.getTime())) from = null;
    let to = req.query.to ? new Date(String(req.query.to)) : new Date();
    if (isNaN(to.getTime())) to = new Date();
    // Mismo fix que en H10: 'YYYY-MM-DD' llega a las 00:00 y se comía el día final.
    to.setUTCHours(23, 59, 59, 999);

    let effectiveFrom = experimentStart;
    if (from && experimentStart && from > experimentStart) effectiveFrom = from;

    // Sin fecha de inicio estampada no hay cohorte: no medimos pre-experimento.
    const participants = experimentStart
      ? await prisma.experimentParticipant.findMany({
          where: {
            experimentKey: H13_KEY,
            assignedAt: { gte: effectiveFrom as Date, lte: to },
          },
          select: {
            userId: true,
            arm: true,
            state: true,
            assignedAt: true,
            user: { select: { country: true } },
          },
        })
      : [];

    // Excluir dogfood/QA: no son asignación aleatoria (mismo criterio que H10).
    const cohort = participants.filter((p) => !isH13Whitelisted(p.userId));
    const cohortIds = cohort.map((p) => p.userId);

    // Todas las TX válidas de la cohorte en una sola query (no una por usuario).
    // "Válida" = mismo criterio que ejecuta el reto: monto > 0 y con categoría.
    // Margen de ±2 días por los bordes de zona horaria; el filtro fino es por día local.
    const DAY_MS = 86_400_000;
    let windowFloor: Date | null = null;
    let windowCeil: Date | null = null;
    for (const p of cohort) {
      const lo = new Date(p.assignedAt.getTime() - 2 * DAY_MS);
      const hi = new Date(p.assignedAt.getTime() + (H13_WINDOW_DAYS + 2) * DAY_MS);
      if (!windowFloor || lo < windowFloor) windowFloor = lo;
      if (!windowCeil || hi > windowCeil) windowCeil = hi;
    }

    const txs = cohortIds.length && windowFloor && windowCeil
      ? await prisma.transaction.findMany({
          where: {
            userId: { in: cohortIds },
            amount: { gt: 0 },
            category_id: { not: null },
            date: { gte: windowFloor, lt: windowCeil },
          },
          select: { userId: true, date: true },
        })
      : [];

    const txsByUser = new Map<string, Date[]>();
    for (const t of txs) {
      const list = txsByUser.get(t.userId);
      if (list) list.push(t.date);
      else txsByUser.set(t.userId, [t.date]);
    }

    const now = new Date();
    const acc = {
      reto: { n: 0, matured: 0, reachedTarget: 0, offered: 0, accepted: 0, declined: 0, completed: 0 },
      control: { n: 0, matured: 0, reachedTarget: 0, offered: 0, accepted: 0, declined: 0, completed: 0 },
    };

    for (const p of cohort) {
      const g = p.arm === 'reto' ? acc.reto : acc.control;
      g.n++;

      // Embudo de la oferta — solo tiene sentido en el brazo reto.
      if (p.arm === 'reto') {
        if (p.state && p.state !== 'ASSIGNED') g.offered++;
        if (p.state === 'ACCEPTED' || p.state === 'ACTIVE' || p.state === 'COMPLETED') g.accepted++;
        if (p.state === 'DECLINED') g.declined++;
        if (p.state === 'COMPLETED') g.completed++;
      }

      const country = p.user?.country;
      if (h13WindowEnd(p.assignedAt, country) > now) continue; // ventana abierta → aún no cuenta
      g.matured++;

      const validKeys = new Set(h13WindowDayKeys(p.assignedAt, country));
      const days = new Set<string>();
      for (const d of txsByUser.get(p.userId) ?? []) {
        const key = localDateKey(country, d);
        if (validKeys.has(key)) days.add(key);
      }
      if (days.size >= H13_TARGET_DAYS) g.reachedTarget++;
    }

    const rate = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 10000) / 100 : 0);
    const build = (g: typeof acc.reto) => ({
      n: g.n,
      matured: g.matured,
      inProgress: g.n - g.matured,
      reachedTarget: g.reachedTarget,
      // Denominador = maduros. Con 0 maduros la tasa es 0 y sufficientSample es false.
      targetRate: rate(g.reachedTarget, g.matured),
      offered: g.offered,
      accepted: g.accepted,
      declined: g.declined,
      completed: g.completed,
      acceptRate: rate(g.accepted, g.offered),
    });

    const reto = build(acc.reto);
    const control = build(acc.control);
    const targetLiftPts = Math.round((reto.targetRate - control.targetRate) * 100) / 100;
    // Lift relativo: el umbral pre-comprometido es "reto ≥2× control", que es una
    // razón, no una diferencia en puntos. Null si el control es 0 (no se divide).
    const targetLiftRatio =
      control.targetRate > 0 ? Math.round((reto.targetRate / control.targetRate) * 100) / 100 : null;

    const sufficientSample =
      reto.matured >= H13_MIN_SAMPLE_PER_ARM && control.matured >= H13_MIN_SAMPLE_PER_ARM;

    return res.json({
      data: {
        enabled,
        from: effectiveFrom ? effectiveFrom.toISOString() : null,
        to: to.toISOString(),
        experimentStart: experimentStart ? experimentStart.toISOString() : null,
        windowDays: H13_WINDOW_DAYS,
        targetDays: H13_TARGET_DAYS,
        minSamplePerArm: H13_MIN_SAMPLE_PER_ARM,
        sufficientSample,
        reto,
        control,
        targetLiftPts,
        targetLiftRatio,
      },
    });
  } catch (error) {
    logger.error('[Experiments] Error H13 stats:', error);
    return res.status(500).json({ message: 'Error calculando métricas del experimento', error: 'Internal server error' });
  }
};
