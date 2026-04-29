import crypto from 'crypto';
import { logger } from '../utils/logger';

/**
 * TikTok Events API — server-side mirror del Pixel cliente.
 *
 * Misma lógica que Meta CAPI:
 *  - event_id: MISMO UUID que el Pixel cliente disparó (deduplicación)
 *  - SHA-256 hashed user properties (email, phone, ttp, external_id)
 *  - IP y UA en claro (TikTok los hashea internamente)
 *
 * Endpoint: POST https://business-api.tiktok.com/open_api/v1.3/event/track/
 */

const TIKTOK_PIXEL_ID = process.env.TIKTOK_PIXEL_ID;
const TIKTOK_EVENTS_API_ACCESS_TOKEN = process.env.TIKTOK_EVENTS_API_ACCESS_TOKEN;
const TIKTOK_TEST_EVENT_CODE = process.env.TIKTOK_TEST_EVENT_CODE; // Opcional, para Events Manager test mode

export interface TiktokEventInput {
  eventName: string;
  eventId: string;
  eventTime?: number; // Unix timestamp en segundos
  pageUrl?: string;
  userData: {
    email?: string | null;
    phone?: string | null;
    ipAddress?: string | null;
    userAgent?: string | null;
    ttclid?: string | null; // TikTok click ID
    externalId?: string | null; // userId de la app
    ttp?: string | null; // TikTok pixel cookie value (_ttp)
  };
  customData?: Record<string, unknown>;
}

export interface TiktokEventsResponse {
  ok: boolean;
  status: number;
  body: unknown;
  error?: string;
}

function isConfigured(): boolean {
  return !!(TIKTOK_PIXEL_ID && TIKTOK_EVENTS_API_ACCESS_TOKEN);
}

function hashSha256(value: string): string {
  return crypto.createHash('sha256').update(value.toLowerCase().trim()).digest('hex');
}

function buildUserContext(input: TiktokEventInput['userData']): Record<string, unknown> {
  const user: Record<string, unknown> = {};

  if (input.email) user.email = hashSha256(input.email);
  if (input.phone) user.phone = hashSha256(input.phone.replace(/\D/g, ''));
  if (input.externalId) user.external_id = hashSha256(input.externalId);

  // IP y UA en claro (TikTok hashea internamente)
  if (input.ipAddress) user.ip = input.ipAddress;
  if (input.userAgent) user.user_agent = input.userAgent;

  // TikTok click ID + pixel cookie
  if (input.ttclid) user.ttclid = input.ttclid;
  if (input.ttp) user.ttp = input.ttp;

  return user;
}

function buildEventPayload(event: TiktokEventInput) {
  const eventTime = event.eventTime ?? Math.floor(Date.now() / 1000);
  return {
    event: event.eventName,
    event_time: eventTime,
    event_id: event.eventId,
    user: buildUserContext(event.userData),
    page: event.pageUrl ? { url: event.pageUrl } : undefined,
    properties: event.customData ?? {},
  };
}

/**
 * Envía un evento a TikTok Events API.
 * Retorna { ok, status, body, error } — nunca lanza.
 */
export async function sendTiktokEventsApiEvent(event: TiktokEventInput): Promise<TiktokEventsResponse> {
  if (!isConfigured()) {
    return {
      ok: false,
      status: 0,
      body: null,
      error: 'TIKTOK_PIXEL_ID or TIKTOK_EVENTS_API_ACCESS_TOKEN not configured',
    };
  }

  const url = 'https://business-api.tiktok.com/open_api/v1.3/event/track/';
  const payload: Record<string, unknown> = {
    event_source: 'web',
    event_source_id: TIKTOK_PIXEL_ID,
    data: [buildEventPayload(event)],
  };

  if (TIKTOK_TEST_EVENT_CODE) {
    payload.test_event_code = TIKTOK_TEST_EVENT_CODE;
  }

  // Timeout 8s — protege contra hangs de TikTok que bloquearían recursos del backend
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Access-Token': TIKTOK_EVENTS_API_ACCESS_TOKEN as string,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const body = (await response.json().catch(() => ({}))) as { code?: number; message?: string };

    // TikTok responde 200 incluso en errores lógicos — hay que chequear body.code
    const tiktokOk = response.ok && body.code === 0;

    if (!tiktokOk) {
      logger.warn(`[TikTokEvents] Evento ${event.eventName} (${event.eventId}) falló: HTTP ${response.status}, code ${body.code}, msg "${body.message}"`);
      return { ok: false, status: response.status, body };
    }

    return { ok: true, status: response.status, body };
  } catch (error) {
    const err = error as Error;
    const isTimeout = err.name === 'AbortError';
    logger.error(`[TikTokEvents] ${isTimeout ? 'Timeout' : 'Error'} enviando ${event.eventName} (${event.eventId}): ${err.message}`);
    return { ok: false, status: 0, body: null, error: err.message };
  } finally {
    clearTimeout(timeoutHandle);
  }
}
