import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { logger } from '../utils/logger';

// Mapea el tipo de notificación a una variante visual del slot (el cliente la usa
// para el color). `data.variant` (si el admin lo definió) gana sobre el default.
function variantForType(type: string, dataVariant?: string): string {
  if (dataVariant) return dataVariant;
  switch (type) {
    case 'MARKETING': return 'promo';
    case 'SYSTEM': return 'warning';
    default: return 'info'; // ANNOUNCEMENT
  }
}

/**
 * GET /api/announcements
 * Mensajes activos del SLOT del dashboard para el usuario autenticado.
 * Filtra: surface slot/both, NO holdout (control), NO descartado del slot (dismissedAt null).
 * Nota: usamos dismissedAt (no readAt) para que LEER el push/notificación no oculte el slot.
 * Devuelve el contrato SlotMessage que la app (AnnouncementSlot) ya sabe pintar.
 */
export const getAnnouncements = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized', message: 'Usuario no autenticado' });

    const rows = await prisma.notificationLog.findMany({
      where: {
        userId,
        holdout: false,
        surface: { in: ['slot', 'both'] },
        dismissedAt: null, // no descartado del slot (leer el push ya NO lo oculta)
        broadcastId: { not: null },
      },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });

    const messages = rows.map((r) => {
      const data = (r.data as any) ?? {};
      // CTA: preferimos el objeto explícito { label, action, params }; si solo vino
      // `screen` (formato del push), lo adaptamos al mismo contrato.
      const cta = data.cta
        ?? (data.screen ? { label: data.ctaLabel ?? 'Ver', action: data.screen } : undefined);
      return {
        id: r.id,
        variant: variantForType(r.type, data.variant),
        icon: data.icon,
        title: r.title,
        body: r.body,
        cta,
        dismissible: data.dismissible ?? true,
        priority: data.priority ?? 0,
      };
    });

    return res.json({ messages });
  } catch (error) {
    logger.error('[Announcements] Error getting announcements:', error);
    return res.status(500).json({ error: 'Internal Server Error', message: 'Error obteniendo anuncios' });
  }
};

/**
 * POST /api/announcements/:id/event   body: { event: 'impression'|'click'|'dismiss' }
 * Registra el evento del slot para medir el funnel (impresión → click → descarte).
 * El updateMany acotado a (id + userId) garantiza que el user solo toca SUS filas.
 * Idempotente: solo escribe el timestamp si todavía estaba en null.
 */
export const trackAnnouncementEvent = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized', message: 'Usuario no autenticado' });

    const { id } = req.params;
    const event = String(req.body?.event || '');
    if (!['impression', 'click', 'dismiss'].includes(event)) {
      return res.status(400).json({ error: 'Bad request', message: 'event inválido (impression|click|dismiss)' });
    }

    const now = new Date();
    const data =
      event === 'impression' ? { impressedAt: now } :
      event === 'click' ? { clickedAt: now } :
      { dismissedAt: now }; // descartar el slot ≠ leer la notificación (readAt lo maneja otro flujo)
    const nullGuard =
      event === 'impression' ? { impressedAt: null } :
      event === 'click' ? { clickedAt: null } :
      { dismissedAt: null };

    await prisma.notificationLog.updateMany({
      // holdout:false + surface slot/both = defensa en profundidad: un evento del
      // slot nunca toca una fila de control (no contamina el funnel de medición).
      where: { id, userId, holdout: false, surface: { in: ['slot', 'both'] }, ...nullGuard },
      data,
    });

    return res.json({ ok: true });
  } catch (error) {
    logger.error('[Announcements] Error tracking event:', error);
    return res.status(500).json({ error: 'Internal Server Error', message: 'Error registrando evento' });
  }
};
