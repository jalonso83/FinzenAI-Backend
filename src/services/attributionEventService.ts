import { prisma } from '../lib/prisma';
import { logger } from '../utils/logger';
import { sendMetaCapiEvent, MetaActionSource } from './metaCapiService';
import { sendTiktokEventsApiEvent } from './tiktokEventsService';

/**
 * Orquestador de eventos de attribution.
 *
 * Flujo:
 *  1. Persiste el evento en attribution_events (sentToMeta/Tiktok = false)
 *  2. Dispara fire-and-forget el envío server-side a Meta CAPI + TikTok Events API
 *  3. Actualiza la fila con sentTo* = true y la respuesta de cada plataforma
 *  4. Si falla, queda con sentTo* = false para que el cron de retry lo reintente
 *
 * Usado por:
 *  - POST /api/events/track (eventos del browser → mirror server-side para deduplicación)
 *  - register controller (CompleteRegistration server-side)
 *  - Stripe webhook (Subscribe server-side)
 *  - RevenueCat webhook (Subscribe server-side)
 */

export type AttributionEventName =
  | 'PageView'
  | 'ViewContent'
  | 'Lead'
  | 'ClickButton'
  | 'InitiateCheckout'
  | 'CompleteRegistration'
  | 'Subscribe'
  | 'Purchase';

export interface IngestEventInput {
  eventName: AttributionEventName | string;
  eventId: string;
  eventTime?: Date;

  // Identidad: al menos uno de estos para que el evento sea útil
  userId?: string | null;
  anonymousId?: string | null;

  // Contexto de attribution (lo que vino del browser/mobile)
  source?: string | null;
  medium?: string | null;
  campaign?: string | null;
  fbclid?: string | null;
  ttclid?: string | null;
  gclid?: string | null;
  pageUrl?: string | null;
  referrerUrl?: string | null;

  // Contexto del cliente (para CAPI/Events API)
  ipAddress?: string | null;
  userAgent?: string | null;
  email?: string | null;
  phone?: string | null;

  // Específico de eventos transaccionales
  value?: number | null;
  currency?: string | null;

  // Origen del evento (afecta action_source en Meta)
  actionSource?: MetaActionSource;

  // Custom data adicional para enviar a CAPI/Events API
  customData?: Record<string, unknown>;
}

/**
 * Ingesta un evento: persiste + dispara mirror a CAPI/Events API.
 *
 * NO BLOQUEA — el caller obtiene el id de attribution_event inmediatamente y los
 * envíos a Meta/TikTok corren en background. Si fallan, el cron de retry los recupera.
 *
 * Idempotente: si el mismo eventId ya fue ingerido (Stripe re-delivery, browser retry,
 * etc.), devuelve el id existente sin re-disparar a las plataformas (que dedupean igual
 * por event_id, pero ahorra API calls).
 */
export async function ingestAttributionEvent(input: IngestEventInput): Promise<{ id: string }> {
  let persistedId: string;
  let isNewEvent = false;

  try {
    const persisted = await prisma.attributionEvent.create({
      data: {
        eventName: input.eventName,
        eventId: input.eventId,
        eventTime: input.eventTime ?? new Date(),
        userId: input.userId ?? null,
        anonymousId: input.anonymousId ?? null,
        source: input.source ?? null,
        medium: input.medium ?? null,
        campaign: input.campaign ?? null,
        fbclid: input.fbclid ?? null,
        ttclid: input.ttclid ?? null,
        gclid: input.gclid ?? null,
        pageUrl: input.pageUrl ?? null,
        referrerUrl: input.referrerUrl ?? null,
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
        value: input.value ?? null,
        currency: input.currency ?? null,
      },
      select: { id: true },
    });
    persistedId = persisted.id;
    isNewEvent = true;
  } catch (error) {
    // P2002 = unique constraint violation en eventId — duplicado, no error real
    const code = (error as { code?: string }).code;
    if (code === 'P2002') {
      const existing = await prisma.attributionEvent.findUnique({
        where: { eventId: input.eventId },
        select: { id: true },
      });
      if (!existing) throw error; // race muy raro — propagamos
      logger.log(`[AttributionEventService] eventId duplicado (${input.eventId}), retornando existente.`);
      return { id: existing.id };
    }
    throw error;
  }

  // 2. Disparar mirror server-side fire-and-forget — solo si es evento nuevo
  if (isNewEvent) {
    void dispatchToProviders(persistedId, input).catch((err) => {
      logger.error(`[AttributionEventService] Error en dispatch async (event ${input.eventId}):`, err);
    });
  }

  return { id: persistedId };
}

/**
 * Envía el evento a Meta CAPI + TikTok Events API en paralelo, actualiza DB con resultados.
 * Si una plataforma falla, sentTo* queda false → el cron de retry lo reintenta luego.
 */
async function dispatchToProviders(persistedId: string, input: IngestEventInput): Promise<void> {
  const eventTimeUnix = Math.floor((input.eventTime ?? new Date()).getTime() / 1000);

  const [metaResult, tiktokResult] = await Promise.all([
    sendMetaCapiEvent({
      eventName: input.eventName,
      eventId: input.eventId,
      eventTime: eventTimeUnix,
      actionSource: input.actionSource ?? 'website',
      eventSourceUrl: input.pageUrl ?? undefined,
      userData: {
        email: input.email,
        phone: input.phone,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
        fbclid: input.fbclid,
        externalId: input.userId,
      },
      customData: {
        ...(input.customData ?? {}),
        ...(input.value != null ? { value: input.value } : {}),
        ...(input.currency ? { currency: input.currency } : {}),
      },
    }),
    sendTiktokEventsApiEvent({
      eventName: input.eventName,
      eventId: input.eventId,
      eventTime: eventTimeUnix,
      pageUrl: input.pageUrl ?? undefined,
      userData: {
        email: input.email,
        phone: input.phone,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
        ttclid: input.ttclid,
        externalId: input.userId,
      },
      customData: {
        ...(input.customData ?? {}),
        ...(input.value != null ? { value: input.value } : {}),
        ...(input.currency ? { currency: input.currency } : {}),
      },
    }),
  ]);

  // 3. Actualizar fila con resultados (parcial OK — solo lo que se mandó bien)
  await prisma.attributionEvent.update({
    where: { id: persistedId },
    data: {
      sentToMeta: metaResult.ok,
      metaResponse: metaResult.body as never,
      sentToTiktok: tiktokResult.ok,
      tiktokResponse: tiktokResult.body as never,
    },
  });
}

/**
 * Reintenta eventos pendientes de envío. Llamado por el cron worker.
 *
 * Procesa en batches pequeños para no saturar APIs externas. Solo reintenta
 * eventos creados en las últimas 24h (más viejos asumimos que ya no aportan).
 */
export async function retryPendingEvents(batchSize = 50): Promise<{
  processed: number;
  metaSent: number;
  tiktokSent: number;
}> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const pending = await prisma.attributionEvent.findMany({
    where: {
      OR: [{ sentToMeta: false }, { sentToTiktok: false }],
      createdAt: { gte: cutoff },
    },
    take: batchSize,
    orderBy: { createdAt: 'asc' },
  });

  let metaSent = 0;
  let tiktokSent = 0;

  for (const event of pending) {
    const eventTimeUnix = Math.floor(event.eventTime.getTime() / 1000);

    const tasks: Array<Promise<unknown>> = [];

    if (!event.sentToMeta) {
      tasks.push(
        sendMetaCapiEvent({
          eventName: event.eventName,
          eventId: event.eventId,
          eventTime: eventTimeUnix,
          actionSource: 'website',
          eventSourceUrl: event.pageUrl ?? undefined,
          userData: {
            ipAddress: event.ipAddress,
            userAgent: event.userAgent,
            fbclid: event.fbclid,
            externalId: event.userId,
          },
          customData: {
            ...(event.value != null ? { value: event.value } : {}),
            ...(event.currency ? { currency: event.currency } : {}),
          },
        }).then(async (res) => {
          if (res.ok) {
            metaSent++;
            await prisma.attributionEvent.update({
              where: { id: event.id },
              data: { sentToMeta: true, metaResponse: res.body as never },
            });
          }
        }),
      );
    }

    if (!event.sentToTiktok) {
      tasks.push(
        sendTiktokEventsApiEvent({
          eventName: event.eventName,
          eventId: event.eventId,
          eventTime: eventTimeUnix,
          pageUrl: event.pageUrl ?? undefined,
          userData: {
            ipAddress: event.ipAddress,
            userAgent: event.userAgent,
            ttclid: event.ttclid,
            externalId: event.userId,
          },
          customData: {
            ...(event.value != null ? { value: event.value } : {}),
            ...(event.currency ? { currency: event.currency } : {}),
          },
        }).then(async (res) => {
          if (res.ok) {
            tiktokSent++;
            await prisma.attributionEvent.update({
              where: { id: event.id },
              data: { sentToTiktok: true, tiktokResponse: res.body as never },
            });
          }
        }),
      );
    }

    await Promise.all(tasks);
  }

  return { processed: pending.length, metaSent, tiktokSent };
}
