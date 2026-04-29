import type { Request, Response } from 'express';
import { ingestAttributionEvent } from '../services/attributionEventService';
import { logger } from '../utils/logger';

/**
 * POST /api/events/track
 *
 * Recibe un evento de tracking del browser/mobile y lo:
 *   1. Persiste en attribution_events
 *   2. Mirror server-side a Meta CAPI + TikTok Events API (deduplicación por event_id)
 *
 * Body esperado:
 * {
 *   eventName: string,            // "Lead", "InitiateCheckout", etc.
 *   eventId: string,              // UUID generado por el frontend (DEBE matchear con fbq/ttq)
 *   anonymousId?: string,         // del cookie de attribution.ts
 *   userId?: string,              // si está autenticado
 *   source/medium/campaign?: string, // first/last touch del attribution payload
 *   fbclid/ttclid/gclid?: string,
 *   pageUrl?: string,
 *   referrerUrl?: string,
 *   email?: string,               // hashed server-side antes de mandar
 *   value?: number,
 *   currency?: string,
 *   customData?: object
 * }
 *
 * Respuesta: 202 Accepted con { id } (el ID de attribution_event creado).
 * El envío server-side a las plataformas corre async — no bloquea la respuesta.
 */
// Allowlist de eventos válidos del browser. Cualquier eventName fuera de esta lista
// se rechaza para prevenir que un atacante pollute Meta/TikTok con eventos arbitrarios.
const ALLOWED_BROWSER_EVENTS = new Set([
  'PageView',
  'ViewContent',
  'Lead',
  'ClickButton',
  'InitiateCheckout',
]);

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STR_CAP = 256;
const CUSTOM_DATA_KEYS = new Set([
  'location', 'platform', 'plan', 'button_text', 'content_id',
  'content_type', 'content_name', 'page', 'section',
]);

/**
 * Sanitiza customData: solo keys whitelisted, valores solo string|number|boolean,
 * cap de longitud por valor, sin __proto__/constructor/prototype.
 */
function sanitizeCustomData(raw: unknown): Record<string, string | number | boolean> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    if (!CUSTOM_DATA_KEYS.has(key)) continue;
    if (typeof value === 'string') {
      out[key] = value.slice(0, STR_CAP);
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function capStr(value: unknown, cap = STR_CAP): string | null {
  if (typeof value !== 'string') return null;
  return value.slice(0, cap);
}

export const trackEvent = async (req: Request, res: Response) => {
  try {
    const body = req.body ?? {};

    // Validaciones de eventName: debe estar en la allowlist
    if (typeof body.eventName !== 'string' || !ALLOWED_BROWSER_EVENTS.has(body.eventName)) {
      return res.status(400).json({ error: 'invalid eventName' });
    }

    // Validación de eventId: debe ser UUID v1-v5 (previene IDs forjados)
    if (typeof body.eventId !== 'string' || !UUID_REGEX.test(body.eventId)) {
      return res.status(400).json({ error: 'eventId must be a valid UUID' });
    }

    // anonymousId también debe ser UUID si se manda
    let anonymousId: string | null = null;
    if (body.anonymousId !== undefined) {
      if (typeof body.anonymousId !== 'string' || !UUID_REGEX.test(body.anonymousId)) {
        return res.status(400).json({ error: 'anonymousId must be a valid UUID' });
      }
      anonymousId = body.anonymousId;
    }

    const userId = (req as { user?: { id?: string } }).user?.id ?? null;

    if (!userId && !anonymousId) {
      return res.status(400).json({ error: 'userId or anonymousId required' });
    }

    // IP y UA del request — confiables (vienen del proxy, no del body)
    const ipAddress = req.ip ?? null;
    const userAgent = req.get('user-agent') ?? null;

    // IMPORTANTE: NO aceptamos email/phone del body. Esos solo se setean cuando el
    // evento se dispara server-side desde un contexto autenticado (register, webhooks).
    // Sin esto, un atacante podría forjar eventos a nombre de cualquier email.
    const result = await ingestAttributionEvent({
      eventName: body.eventName,
      eventId: body.eventId,
      userId,
      anonymousId,
      source: capStr(body.source),
      medium: capStr(body.medium),
      campaign: capStr(body.campaign),
      fbclid: capStr(body.fbclid),
      ttclid: capStr(body.ttclid),
      gclid: capStr(body.gclid),
      pageUrl: capStr(body.pageUrl, 1024),
      referrerUrl: capStr(body.referrerUrl, 1024),
      ipAddress,
      userAgent,
      value: typeof body.value === 'number' && Number.isFinite(body.value) ? body.value : null,
      currency: capStr(body.currency, 8),
      actionSource: 'website',
      customData: sanitizeCustomData(body.customData),
    });

    return res.status(202).json({ id: result.id });
  } catch (error) {
    logger.error('[EventsController] Error tracking event:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
