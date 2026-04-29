import crypto from 'crypto';
import { logger } from '../utils/logger';

/**
 * Meta Conversions API (CAPI) — server-side mirror del Pixel cliente.
 *
 * Cada evento server-side debe incluir:
 *  - event_id: MISMO UUID que el Pixel cliente disparó (deduplicación)
 *  - action_source: "website" para eventos web, "app" para mobile
 *  - user_data: SHA-256 hashed (email, phone, IP, UA, etc.)
 *
 * Si el event_id matchea, Meta cuenta 1 conversión, no 2.
 */

const META_PIXEL_ID = process.env.META_PIXEL_ID;
const META_CAPI_ACCESS_TOKEN = process.env.META_CAPI_ACCESS_TOKEN;
const META_API_VERSION = 'v21.0';
const META_TEST_EVENT_CODE = process.env.META_TEST_EVENT_CODE; // Opcional, para Test Events

export type MetaActionSource = 'website' | 'app' | 'system_generated';

export interface MetaEventInput {
  eventName: string;
  eventId: string;
  eventTime?: number; // Unix timestamp en segundos
  actionSource?: MetaActionSource;
  eventSourceUrl?: string;
  userData: {
    email?: string | null;
    phone?: string | null;
    ipAddress?: string | null;
    userAgent?: string | null;
    fbclid?: string | null;
    externalId?: string | null; // userId de la app
  };
  customData?: Record<string, unknown>;
}

export interface MetaCapiResponse {
  ok: boolean;
  status: number;
  body: unknown;
  error?: string;
}

function isConfigured(): boolean {
  return !!(META_PIXEL_ID && META_CAPI_ACCESS_TOKEN);
}

/**
 * Hashea un valor con SHA-256 según specs de Meta.
 * - Lowercase + trim antes de hashear
 * - Devuelve hex lowercase
 */
function hashSha256(value: string): string {
  return crypto.createHash('sha256').update(value.toLowerCase().trim()).digest('hex');
}

/**
 * Construye el bloque user_data según specs de Meta CAPI v21.0.
 * Solo hashea valores presentes; los ausentes se omiten.
 */
function buildUserData(input: MetaEventInput['userData']): Record<string, unknown> {
  const userData: Record<string, unknown> = {};

  if (input.email) userData.em = [hashSha256(input.email)];
  if (input.phone) userData.ph = [hashSha256(input.phone.replace(/\D/g, ''))]; // solo dígitos
  if (input.externalId) userData.external_id = [hashSha256(input.externalId)];

  // IP y UA NO se hashean (Meta los recibe en claro y hashea internamente)
  if (input.ipAddress) userData.client_ip_address = input.ipAddress;
  if (input.userAgent) userData.client_user_agent = input.userAgent;

  // fbclid → fbc en formato Meta-specific
  if (input.fbclid) {
    const timestamp = Math.floor(Date.now() / 1000);
    userData.fbc = `fb.1.${timestamp}.${input.fbclid}`;
  }

  return userData;
}

/**
 * Construye el payload de un evento según specs Meta CAPI.
 */
function buildEventPayload(event: MetaEventInput) {
  const eventTime = event.eventTime ?? Math.floor(Date.now() / 1000);
  return {
    event_name: event.eventName,
    event_time: eventTime,
    event_id: event.eventId,
    event_source_url: event.eventSourceUrl,
    action_source: event.actionSource ?? 'website',
    user_data: buildUserData(event.userData),
    custom_data: event.customData ?? {},
  };
}

/**
 * Envía un evento a Meta Conversions API.
 * Retorna { ok, status, body, error } — nunca lanza.
 */
export async function sendMetaCapiEvent(event: MetaEventInput): Promise<MetaCapiResponse> {
  if (!isConfigured()) {
    return {
      ok: false,
      status: 0,
      body: null,
      error: 'META_PIXEL_ID or META_CAPI_ACCESS_TOKEN not configured',
    };
  }

  const url = `https://graph.facebook.com/${META_API_VERSION}/${META_PIXEL_ID}/events`;
  const payload: Record<string, unknown> = {
    data: [buildEventPayload(event)],
    access_token: META_CAPI_ACCESS_TOKEN,
  };

  if (META_TEST_EVENT_CODE) {
    payload.test_event_code = META_TEST_EVENT_CODE;
  }

  // Timeout 8s — protege contra hangs de Meta que bloquearían recursos del backend
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
      logger.warn(`[MetaCAPI] Evento ${event.eventName} (${event.eventId}) falló: ${response.status}`);
      return { ok: false, status: response.status, body };
    }

    return { ok: true, status: response.status, body };
  } catch (error) {
    const err = error as Error;
    const isTimeout = err.name === 'AbortError';
    logger.error(`[MetaCAPI] ${isTimeout ? 'Timeout' : 'Error'} enviando ${event.eventName} (${event.eventId}): ${err.message}`);
    return { ok: false, status: 0, body: null, error: err.message };
  } finally {
    clearTimeout(timeoutHandle);
  }
}
