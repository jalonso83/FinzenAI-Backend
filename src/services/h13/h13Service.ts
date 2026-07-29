import { prisma } from '../../lib/prisma';
import { logger } from '../../utils/logger';
import { NotificationType } from '@prisma/client';
import { isH13Enabled, isH13Whitelisted, isH13FlagOn, assignArm } from '../../config/h13';
import { getOrStampExperimentStart } from '../../lib/experimentStart';
import { trackExperimentEvent } from '../experiments/experimentEvents';
import { getTimezoneByCountry } from '../../utils/timezone';
import { NotificationService } from '../notificationService';

const WINDOW_DAYS = 7;
const BADGE_ID = 'reto_primera_semana';

/**
 * Definición de la métrica primaria, exportada para que el análisis mida
 * EXACTAMENTE lo mismo que ejecuta la app: "% de asignados con ≥3 días
 * distintos con TX válida en la ventana de 7 días". Si el panel reimplementara
 * estos números por su cuenta, cualquier divergencia parecería un bug de datos.
 */
export const H13_WINDOW_DAYS = WINDOW_DAYS;
export const H13_TARGET_DAYS = 3;

interface RetoTx {
  date: Date;
  amount: number;
  type: string;
  category: { name: string } | null;
}

/**
 * TX válidas dentro de la ventana del reto, anclada al DÍA CALENDARIO LOCAL de la
 * asignación (no al instante — así la TX de activación del día 1 SÍ cuenta, y el
 * borde superior no depende de la hora de asignación). Fuente de verdad = transactions.
 */
async function retoWindowTxs(userId: string, assignedAt: Date, country: string | null | undefined): Promise<RetoTx[]> {
  const assignedDayKey = localDateKey(country, assignedAt); // 'YYYY-MM-DD' local
  const base = new Date(`${assignedDayKey}T00:00:00Z`);
  const validKeys = new Set<string>(h13WindowDayKeys(assignedAt, country));
  // Traer con margen de ±2 días (bordes de timezone) y filtrar por día local.
  const from = new Date(base.getTime() - 2 * 86_400_000);
  const to = new Date(base.getTime() + (WINDOW_DAYS + 2) * 86_400_000);
  const txs = await prisma.transaction.findMany({
    where: { userId, amount: { gt: 0 }, category_id: { not: null }, date: { gte: from, lt: to } },
    select: { date: true, amount: true, type: true, category: { select: { name: true } } },
  });
  return txs.filter((t) => validKeys.has(localDateKey(country, t.date)));
}

function countDistinctDays(txs: RetoTx[], country: string | null | undefined): number {
  return new Set(txs.map((t) => localDateKey(country, t.date))).size;
}

/**
 * Los WINDOW_DAYS días calendario LOCALES de la ventana del reto ('YYYY-MM-DD'),
 * anclados al día local de la asignación (incluido: la TX de activación cuenta).
 * Exportada para que el análisis del panel reconstruya la misma ventana sin
 * reimplementarla — ver H13_TARGET_DAYS.
 */
export function h13WindowDayKeys(assignedAt: Date, country: string | null | undefined): string[] {
  const base = new Date(`${localDateKey(country, assignedAt)}T00:00:00Z`);
  const keys: string[] = [];
  for (let i = 0; i < WINDOW_DAYS; i++) {
    keys.push(new Date(base.getTime() + i * 86_400_000).toISOString().slice(0, 10));
  }
  return keys;
}

/**
 * Instante en que se cierra la ventana de un participante (fin del último día
 * local + 1). Antes de esa fecha su resultado TODAVÍA no es final: contarlo en
 * la métrica primaria diluiría la tasa con gente que aún tiene días por delante.
 */
export function h13WindowEnd(assignedAt: Date, country: string | null | undefined): Date {
  const base = new Date(`${localDateKey(country, assignedAt)}T00:00:00Z`);
  return new Date(base.getTime() + WINDOW_DAYS * 86_400_000);
}

/** Análisis rule-based (sin LLM, sin gate PRO) sobre las TX de la ventana del reto. */
function buildRetoAnalysis(txs: RetoTx[], country: string | null | undefined): string {
  const days = countDistinctDays(txs, country);
  const gastos = txs.filter((t) => t.type === 'EXPENSE');
  const totalGasto = gastos.reduce((s, t) => s + t.amount, 0);
  const byCat = new Map<string, number>();
  for (const t of gastos) {
    const c = t.category?.name ?? 'Otros';
    byCat.set(c, (byCat.get(c) ?? 0) + t.amount);
  }
  let topCat = '';
  let topAmount = 0;
  for (const [c, amt] of byCat) if (amt > topAmount) { topCat = c; topAmount = amt; }

  let text = `Registraste ${txs.length} ${txs.length === 1 ? 'movimiento' : 'movimientos'} en ${days} días`;
  if (totalGasto > 0) text += `, RD$${totalGasto.toLocaleString('es-DO')} en gastos`;
  if (topCat) text += `. Tu categoría top: ${topCat} (RD$${topAmount.toLocaleString('es-DO')})`;
  return `${text}. ¡Vas por buen camino! 🎉`;
}

/** Día calendario del usuario en su zona (YYYY-MM-DD). Las TX se guardan a mediodía UTC. */
export function localDateKey(country: string | null | undefined, when: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: getTimezoneByCountry(country) }).format(when);
  } catch {
    return when.toISOString().slice(0, 10);
  }
}

/**
 * H13 · Reto de la Primera Semana. Usa la infra GENÉRICA de experimentos
 * (experiment_participants + experiment_events, keyed por experimentKey='h13').
 * NO crea tablas propias. La asignación de brazo es por hash (stateless); esta
 * fila guarda el ESTADO del reto (que no se puede recalcular).
 */
export const H13_KEY = 'h13';

/**
 * Forma tipada del JSON `data` del participante en H13. Todo lo específico del
 * experimento vive aquí — así no se agregan columnas ni tablas por experimento.
 */
export interface H13Data {
  activationTxId?: string;
  utmSource?: string;
  platform?: string;
  offerShownAt?: string;         // ISO — 1ª vez que se sirvió la oferta
  reminderHour?: number;         // 12 | 18 | 21 (hora local por país)
  acceptedAt?: string;           // ISO
  optedOutAt?: string;           // ISO
  daysWithTx?: number;           // días distintos con TX válida en la ventana
  analysisUnlockedAt?: string;   // ISO
  analysisText?: string;         // análisis rule-based del día-3 (sin PRO)
  completedAt?: string;          // ISO
  result?: string;               // '>=3' | '<3'
}

// ─── Copy v1 (borrador del paquete de Junior; se reemplaza con el aprobado) ───
const OFFER_MESSAGE =
  '¡Primera anotada! 🔥 Te propongo el Reto de la Primera Semana. Registra lo que se ' +
  'mueva en tu plata 3 días de los próximos 7, y yo te entrego un análisis real, hecho ' +
  'para ti. ¿Te apuntas?';
const HOUR_MESSAGE = '¿A qué hora te cuadra anotar tu día?';

const OFFER_BUTTONS = [
  { label: 'Acepto el reto', action: 'h13_offer', value: 'accept' },
  { label: 'Ahora no', action: 'h13_offer', value: 'decline' },
];
const HOUR_BUTTONS = [
  { label: '☀️ Mediodía', action: 'h13_hour', value: '12' },
  { label: '🌆 Tarde', action: 'h13_hour', value: '18' },
  { label: '🌙 Noche', action: 'h13_hour', value: '21' },
];

export interface H13View {
  view: 'offer' | 'hour_picker' | 'none';
  message?: string;
  buttons?: { label: string; action: string; value: string }[];
}

function getParticipant(userId: string) {
  return prisma.experimentParticipant.findUnique({
    where: { userId_experimentKey: { userId, experimentKey: H13_KEY } },
  });
}

function readData(p: { data: unknown } | null): H13Data {
  return (p?.data as H13Data) ?? {};
}

/**
 * Estado de H13 para el app (Fase 3, servido en GET /api/h13/state al abrir el
 * dashboard). Devuelve qué mostrar en el slot: la oferta, el selector de hora, o
 * nada. Emite h13_offer_shown la 1ª vez que sirve la oferta (idempotente).
 */
export async function getH13State(userId: string): Promise<H13View> {
  if (!isH13Enabled(userId)) return { view: 'none' };
  const p = await getParticipant(userId);
  if (!p || p.arm !== 'reto') return { view: 'none' };

  if (p.state === 'OFFERED') {
    const data = readData(p);
    if (!data.offerShownAt) {
      await prisma.experimentParticipant.update({
        where: { id: p.id },
        data: { data: { ...data, offerShownAt: new Date().toISOString() } as object },
      });
      await trackExperimentEvent(H13_KEY, userId, 'h13_offer_shown', {});
    }
    return { view: 'offer', message: OFFER_MESSAGE, buttons: OFFER_BUTTONS };
  }

  if (p.state === 'ACCEPTED') {
    return { view: 'hour_picker', message: HOUR_MESSAGE, buttons: HOUR_BUTTONS };
  }

  return { view: 'none' };
}

/** Respuesta a la oferta (POST /api/h13/offer). ITT: aunque decline, sigue en el brazo. */
export async function respondOffer(userId: string, decision: 'accept' | 'decline'): Promise<H13View> {
  if (!isH13Enabled(userId)) return { view: 'none' };
  const p = await getParticipant(userId);
  if (!p || p.arm !== 'reto') return { view: 'none' };

  if (decision === 'accept') {
    if (p.state === 'OFFERED') {
      await prisma.experimentParticipant.update({ where: { id: p.id }, data: { state: 'ACCEPTED' } });
      await trackExperimentEvent(H13_KEY, userId, 'h13_offer_accepted', {});
    }
    // Idempotente ante doble-tap: si ya aceptó (o acaba de aceptar), sirve el selector.
    if (p.state === 'OFFERED' || p.state === 'ACCEPTED') {
      return { view: 'hour_picker', message: HOUR_MESSAGE, buttons: HOUR_BUTTONS };
    }
    return { view: 'none' };
  }

  // decline — solo transiciona desde OFFERED; si ya avanzó, no revierte (ITT).
  if (p.state === 'OFFERED') {
    await prisma.experimentParticipant.update({ where: { id: p.id }, data: { state: 'DECLINED' } });
    await trackExperimentEvent(H13_KEY, userId, 'h13_offer_declined', {});
  }
  return { view: 'none' };
}

/** Elección de hora del recordatorio (POST /api/h13/hour). Arranca el reto (ACTIVE). */
export async function setReminderHour(userId: string, hour: number): Promise<{ ok: boolean }> {
  if (!isH13Enabled(userId)) return { ok: false };
  if (![12, 18, 21].includes(hour)) return { ok: false };
  const p = await getParticipant(userId);
  if (!p || p.arm !== 'reto' || (p.state !== 'ACCEPTED' && p.state !== 'ACTIVE')) return { ok: false };

  const data = readData(p);
  await prisma.experimentParticipant.update({
    where: { id: p.id },
    data: {
      state: 'ACTIVE',
      data: { ...data, reminderHour: hour, acceptedAt: data.acceptedAt ?? new Date().toISOString() } as object,
    },
  });
  return { ok: true };
}

/** Silenciar recordatorios (POST /api/h13/optout). Sigue en el brazo (ITT), solo apaga cues. */
export async function optOutCues(userId: string): Promise<{ ok: boolean }> {
  if (!isH13Enabled(userId)) return { ok: false };
  const p = await getParticipant(userId);
  if (!p || p.arm !== 'reto') return { ok: false };

  const data = readData(p);
  if (!data.optedOutAt) {
    await prisma.experimentParticipant.update({
      where: { id: p.id },
      data: { data: { ...data, optedOutAt: new Date().toISOString() } as object },
    });
    await trackExperimentEvent(H13_KEY, userId, 'h13_optout', {});
  }
  return { ok: true };
}

/**
 * Hook central de asignación. Se llama desde AMBAS rutas de creación de transacción
 * (REST controllers/transactions.ts y Zenio controllers/zenioAgents.ts) — si solo
 * se enganchara el REST, todos los registros por Zenio (que el reto incentiva)
 * quedarían fuera del experimento.
 *
 * Detecta la PRIMERA transacción válida del usuario y lo asigna 50/50 al brazo.
 * Best-effort: nunca lanza (no debe romper la creación de la transacción).
 */
export async function onValidTransaction(userId: string, txId: string): Promise<{ insight?: string }> {
  try {
    if (!isH13Enabled(userId)) return {};

    // Fecha de inicio del experimento: se estampa sola la primera vez que el flag
    // GLOBAL se ve live (misma solución que H10 — ver lib/experimentStart). Sin
    // esto habría que reconstruir a mano cuándo arrancó, que fue justo el dolor
    // que costó tres intentos en H10. Fire-and-forget: no debe frenar la TX.
    // No cuenta la whitelist a propósito (dogfood no es el arranque real).
    if (isH13FlagOn()) {
      void getOrStampExperimentStart(H13_KEY).catch((e) =>
        logger.error('[H13] No se pudo estampar la fecha de inicio:', e),
      );
    }

    // ¿Ya está en el experimento?
    const existing = await prisma.experimentParticipant.findUnique({
      where: { userId_experimentKey: { userId, experimentKey: H13_KEY } },
    });
    if (existing) {
      // Ya asignado. Si es un reto en curso, procesar el progreso del día (Fase 5-6).
      if (existing.arm === 'reto' && existing.state === 'ACTIVE') {
        return await processRetoProgress(txId, existing);
      }
      return {};
    }

    // ¿Es su PRIMERA transacción? La actual ya está creada, así que count === 1.
    // Excepción para dogfood/QA: una cuenta de prueba ya usada nunca vuelve a
    // tener count === 1, así que sin esto la whitelist no sirve para probar el
    // flujo. Solo aplica a usuarios listados a mano en H13_WHITELIST.
    const txCount = await prisma.transaction.count({ where: { userId } });
    if (txCount !== 1 && !isH13Whitelisted(userId)) return;

    const arm = assignArm(userId);

    // Cortes de análisis (no de asignación): utm_source (first-touch) + plataforma.
    let utmSource: string | undefined;
    let platform: string | undefined;
    try {
      const attr = await prisma.userAttribution.findUnique({
        where: { userId },
        select: { firstTouchSource: true },
      });
      utmSource = attr?.firstTouchSource ?? undefined;
    } catch { /* best-effort */ }
    try {
      const device = await prisma.userDevice.findFirst({
        where: { userId, isActive: true },
        orderBy: { lastUsedAt: 'desc' },
        select: { platform: true },
      });
      platform = device?.platform ?? undefined;
    } catch { /* best-effort */ }

    const data: H13Data = { activationTxId: txId, utmSource, platform };

    try {
      await prisma.experimentParticipant.create({
        data: {
          userId,
          experimentKey: H13_KEY,
          arm,
          // El brazo 'reto' queda listo para que la oferta se sirva vía
          // GET /api/h13/state (Fase 3) cuando el usuario abra el dashboard.
          state: arm === 'reto' ? 'OFFERED' : 'ASSIGNED',
          data: data as object,
        },
      });
    } catch (e: unknown) {
      // P2002: otro request concurrente (2ª TX simultánea) ya enroló al usuario.
      // No es error — el @@unique(userId,experimentKey) hizo su trabajo. Salimos
      // sin re-emitir h13_assigned (ya lo emitió el request que ganó).
      if ((e as { code?: string })?.code === 'P2002') return {};
      throw e;
    }

    await trackExperimentEvent(H13_KEY, userId, 'h13_assigned', { arm, utmSource, platform, txId });
    logger.log(`[H13] Usuario ${userId} asignado al brazo '${arm}' (1ª TX ${txId})`);
    return {};
  } catch (err) {
    logger.error(`[H13] Error en onValidTransaction para ${userId}:`, err);
    return {};
  }
}

// ─── Fase 5-6 · Progreso del reto (se corre en CADA TX del brazo reto ACTIVE) ───

/** Micro-insight rule-based (sin LLM). Prioridad: categoría → días → conteo → fallback. */
async function computeInsight(
  userId: string,
  txId: string,
  daysWithTx: number,
): Promise<{ text: string; type: string } | null> {
  const tx = await prisma.transaction.findUnique({
    where: { id: txId },
    include: { category: { select: { name: true } } },
  });
  if (!tx) return null;

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  // P1: categoría con ≥2 TX de gasto este mes → suma acumulada.
  if (tx.category_id && tx.type === 'EXPENSE') {
    const catTx = await prisma.transaction.findMany({
      where: { userId, category_id: tx.category_id, type: 'EXPENSE', date: { gte: monthStart } },
      select: { amount: true },
    });
    if (catTx.length >= 2) {
      const sum = catTx.reduce((s, t) => s + t.amount, 0);
      return {
        text: `Llevas RD$${sum.toLocaleString('es-DO')} en ${tx.category?.name ?? 'esta categoría'} este mes.`,
        type: 'categoria',
      };
    }
  }
  // P2: días del reto ≥2.
  if (daysWithTx >= 2) return { text: `Racha de ${daysWithTx} días 🔥`, type: 'racha' };
  // P3: primer día del reto → mensaje de arranque.
  if (daysWithTx <= 1) {
    return { text: 'Primer paso dado. Desde ya empiezo a aprender de tu plata.', type: 'primer_dia' };
  }
  // Fallback defensivo (no debería alcanzarse).
  const weekStart = new Date(now.getTime() - 7 * 86_400_000);
  const weekCount = await prisma.transaction.count({ where: { userId, date: { gte: weekStart } } });
  return { text: `Con esta van ${weekCount} esta semana.`, type: 'conteo' };
}

/**
 * Progreso del reto tras una TX válida. daysWithTx = días DISTINTOS con TX válida en
 * la ventana (contado desde transactions = fuente de verdad, respeta "día de gracia"
 * porque cuenta días distintos, no consecutivos). Emite day_completed al subir, sirve
 * el micro-insight, y desbloquea el análisis al 3er día (Fase 6).
 */
async function processRetoProgress(
  txId: string,
  p: { id: string; userId: string; assignedAt: Date; data: unknown },
): Promise<{ insight?: string }> {
  const userId = p.userId;
  const data = (p.data as H13Data) ?? {};
  const assignedAt = new Date(p.assignedAt);
  const now = new Date();

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { country: true } });
  const country = user?.country;

  // Ventana en días calendario locales (no instante): fin = inicio del día local de
  // asignación + 7 días. Si ya venció, el cierre lo maneja el scheduler.
  const assignedDayStart = new Date(`${localDateKey(country, assignedAt)}T00:00:00Z`);
  const windowEnd = new Date(assignedDayStart.getTime() + WINDOW_DAYS * 86_400_000);
  if (now > windowEnd) return {};

  // Días distintos con TX válida en la ventana (día calendario local; incluye la TX
  // de activación del día 1). Fuente de verdad = transactions.
  const windowTxs = await retoWindowTxs(userId, assignedAt, country);
  const daysWithTx = countDistinctDays(windowTxs, country);

  const newData: H13Data = { ...data };
  let changed = false;

  if (daysWithTx > (data.daysWithTx ?? 0)) {
    newData.daysWithTx = daysWithTx;
    changed = true;
    await trackExperimentEvent(H13_KEY, userId, 'h13_day_completed', { daysWithTx });
  }

  // Micro-insight (cada TX).
  const insight = await computeInsight(userId, txId, daysWithTx);
  if (insight) await trackExperimentEvent(H13_KEY, userId, 'h13_insight_shown', { type: insight.type });

  // Desbloqueo día-3: análisis rule-based (sin gate PRO) sobre la ventana REAL del
  // reto, entregado en el push. Re-lectura fresca para reducir el race de doble push.
  if (daysWithTx >= H13_TARGET_DAYS && !data.analysisUnlockedAt) {
    const fresh = await prisma.experimentParticipant.findUnique({
      where: { id: p.id },
      select: { data: true },
    });
    const freshData = (fresh?.data as H13Data) ?? {};
    if (!freshData.analysisUnlockedAt) {
      const analysis = buildRetoAnalysis(windowTxs, country);
      newData.analysisUnlockedAt = now.toISOString();
      newData.analysisText = analysis;
      changed = true;
      await trackExperimentEvent(H13_KEY, userId, 'h13_analysis_unlocked', {});
      await NotificationService.sendToUser(userId, NotificationType.SYSTEM, {
        title: '🎁 Completaste 3 días del reto',
        body: analysis,
        data: { screen: 'Dashboard', h13: 'analysis' },
      });
    }
  }

  if (changed) {
    await prisma.experimentParticipant.update({ where: { id: p.id }, data: { data: newData as object } });
  }
  return { insight: insight?.text };
}

// ─── Fase 8 · Supresión de otros schedulers durante el reto ───

/**
 * ¿El usuario está en un reto H13 en curso (ACTIVE)? Se usa para SUPRIMIR Tips y las
 * notificaciones de onboarding de Trial durante los 7 días del reto, y así evitar
 * sobre-notificación. NO suprime alertas de Budget/Goal/Payment ni la expiración del
 * trial (esas siguen normales). Best-effort: ante error, no suprime (devuelve false).
 */
export async function isInActiveReto(userId: string): Promise<boolean> {
  if (!isH13Enabled(userId)) return false;
  try {
    const p = await prisma.experimentParticipant.findUnique({
      where: { userId_experimentKey: { userId, experimentKey: H13_KEY } },
      select: { arm: true, state: true },
    });
    return p?.arm === 'reto' && p.state === 'ACTIVE';
  } catch {
    return false;
  }
}

// ─── Fase 7 · Cierre del reto (día 7). Llamado por el scheduler cada hora. ───

/**
 * Cierra los retos cuya ventana de 7 días venció y aún no están COMPLETED. Marca
 * COMPLETED, emite h13_completed con el resultado, y — para quienes aceptaron
 * (llegaron a ACTIVE) — da badge si ≥3 días y manda el mensaje de cierre.
 * El control no se toca (solo tiene h13_assigned). Best-effort.
 */
export async function closeExpiredChallenges(): Promise<void> {
  if (!isH13Enabled()) return;
  const now = new Date();
  const cutoff = new Date(now.getTime() - WINDOW_DAYS * 86_400_000);

  const expired = await prisma.experimentParticipant.findMany({
    where: {
      experimentKey: H13_KEY,
      arm: 'reto',
      state: { in: ['OFFERED', 'ACCEPTED', 'ACTIVE', 'DECLINED'] },
      assignedAt: { lte: cutoff },
    },
    select: { id: true, userId: true, state: true, assignedAt: true, data: true },
  });

  for (const p of expired) {
    try {
      const data = (p.data as H13Data) ?? {};
      const assignedAt = new Date(p.assignedAt);

      const user = await prisma.user.findUnique({ where: { id: p.userId }, select: { country: true } });
      const windowTxs = await retoWindowTxs(p.userId, assignedAt, user?.country);
      const daysWithTx = countDistinctDays(windowTxs, user?.country);
      const success = daysWithTx >= H13_TARGET_DAYS;
      const result = success ? '>=3' : '<3';

      // Lock atómico: solo el primer run que lo pase a COMPLETED sigue (evita doble
      // cierre / doble h13_completed si un tick del cron se solapa con el siguiente).
      const locked = await prisma.experimentParticipant.updateMany({
        where: { id: p.id, state: { not: 'COMPLETED' } },
        data: {
          state: 'COMPLETED',
          data: { ...data, daysWithTx, completedAt: now.toISOString(), result } as object,
        },
      });
      if (locked.count === 0) continue; // otro run ya lo cerró

      await trackExperimentEvent(H13_KEY, p.userId, 'h13_completed', { daysWithTx, result });

      // Mensaje de cierre + badge para quienes PARTICIPARON (aceptaron: ACTIVE o
      // ACCEPTED — un ACCEPTED que registró ≥3 días sí merece su recompensa).
      // OFFERED/DECLINED se cierran para medición pero sin push (nunca aceptaron).
      if (p.state === 'ACTIVE' || p.state === 'ACCEPTED') {
        if (success) {
          try {
            await prisma.userBadge.create({ data: { userId: p.userId, badgeId: BADGE_ID } });
          } catch { /* @@unique: ya lo tenía */ }
          await NotificationService.sendToUser(p.userId, NotificationType.SYSTEM, {
            title: 'Reto completado 🏆',
            body: 'Te ganaste tu badge. ¿Seguimos la racha esta semana?',
            data: { screen: 'Dashboard', h13: 'close' },
          });
        } else {
          await NotificationService.sendToUser(p.userId, NotificationType.SYSTEM, {
            title: 'El reto terminó',
            body: 'Esto no es de una semana. Cuando quieras retomamos, sin lío. Aquí estoy.',
            data: { screen: 'Dashboard', h13: 'close' },
          });
        }
      }
    } catch (err) {
      logger.error(`[H13] Error cerrando reto de ${p.userId}:`, err);
    }
  }
}
