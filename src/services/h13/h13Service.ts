import { prisma } from '../../lib/prisma';
import { logger } from '../../utils/logger';
import { isH13Enabled, assignArm } from '../../config/h13';
import { trackExperimentEvent } from '../experiments/experimentEvents';

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
  analysisReportId?: string;     // WeeklyReport del 3er día
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
export async function onValidTransaction(userId: string, txId: string): Promise<void> {
  try {
    if (!isH13Enabled(userId)) return;

    // ¿Ya está en el experimento? No reasignar.
    const existing = await prisma.experimentParticipant.findUnique({
      where: { userId_experimentKey: { userId, experimentKey: H13_KEY } },
      select: { id: true },
    });
    if (existing) return;

    // ¿Es su PRIMERA transacción? La actual ya está creada, así que count === 1.
    const txCount = await prisma.transaction.count({ where: { userId } });
    if (txCount !== 1) return;

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
      if ((e as { code?: string })?.code === 'P2002') return;
      throw e;
    }

    await trackExperimentEvent(H13_KEY, userId, 'h13_assigned', { arm, utmSource, platform, txId });
    logger.log(`[H13] Usuario ${userId} asignado al brazo '${arm}' (1ª TX ${txId})`);
  } catch (err) {
    logger.error(`[H13] Error en onValidTransaction para ${userId}:`, err);
  }
}
