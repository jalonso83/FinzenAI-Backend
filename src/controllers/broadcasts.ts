import { Request, Response } from 'express';
import { NotificationType } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { logger } from '../utils/logger';
import { BroadcastService, AudienceFilters } from '../services/broadcastService';

const ALLOWED_TYPES: NotificationType[] = [
  NotificationType.MARKETING,
  NotificationType.ANNOUNCEMENT,
  NotificationType.SYSTEM,
];
const TITLE_MAX = 100;
const BODY_MAX = 200;

function validateContent(body: any): string | null {
  if (!body?.title || typeof body.title !== 'string' || body.title.trim().length === 0) return 'Título requerido';
  if (body.title.length > TITLE_MAX) return `Título excede ${TITLE_MAX} caracteres`;
  if (!body?.body || typeof body.body !== 'string' || body.body.trim().length === 0) return 'Mensaje requerido';
  if (body.body.length > BODY_MAX) return `Mensaje excede ${BODY_MAX} caracteres`;
  if (!ALLOWED_TYPES.includes(body.type)) return 'Tipo inválido (MARKETING | ANNOUNCEMENT | SYSTEM)';
  return null;
}

function validateAudience(audience: any): string | null {
  if (!audience || typeof audience !== 'object') return 'Audiencia requerida';
  // Modo prueba: solo va al admin, no requiere segmentación.
  if (audience.test === true) return null;
  if (!Array.isArray(audience.segments) || audience.segments.length === 0) return 'Selecciona al menos un segmento';
  if (!Array.isArray(audience.plans) || audience.plans.length === 0) return 'Selecciona al menos un plan';
  if (!Array.isArray(audience.platforms) || audience.platforms.length === 0) return 'Selecciona al menos una plataforma';
  return null;
}

// POST /api/admin/broadcasts — crea en estado DRAFT
export const createBroadcast = async (req: Request, res: Response) => {
  try {
    const adminId = (req.user as any)?.id as string | undefined;
    if (!adminId) return res.status(401).json({ message: 'Unauthorized', error: 'Missing admin' });

    const contentError = validateContent(req.body);
    if (contentError) return res.status(400).json({ message: contentError, error: 'Bad request' });
    const audienceError = validateAudience(req.body.audience);
    if (audienceError) return res.status(400).json({ message: audienceError, error: 'Bad request' });

    // Modo prueba: el destinatario es SIEMPRE el admin autenticado (no se confía
    // en un testUserId que venga del cliente).
    const audience = req.body.audience.test === true
      ? { ...req.body.audience, testUserId: adminId }
      : req.body.audience;

    const broadcast = await prisma.broadcast.create({
      data: {
        title: req.body.title,
        body: req.body.body,
        type: req.body.type,
        data: req.body.data ?? undefined,
        audience,
        status: 'DRAFT',
        createdBy: adminId,
      },
    });
    return res.status(201).json({ message: 'Broadcast creado', data: broadcast });
  } catch (error) {
    logger.error('[Broadcast] Error creando broadcast:', error);
    return res.status(500).json({ message: 'Error creando broadcast', error: 'Internal server error' });
  }
};

// GET /api/admin/broadcasts — historial paginado
export const listBroadcasts = async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(String(req.query.limit ?? '20'), 10) || 20));

    const [items, total] = await Promise.all([
      prisma.broadcast.findMany({
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.broadcast.count(),
    ]);

    return res.json({
      message: 'Broadcasts retrieved',
      data: { items, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } },
    });
  } catch (error) {
    logger.error('[Broadcast] Error listando broadcasts:', error);
    return res.status(500).json({ message: 'Error listando broadcasts', error: 'Internal server error' });
  }
};

// POST /api/admin/broadcasts/preview — calcula audiencia sin enviar
export const previewBroadcast = async (req: Request, res: Response) => {
  try {
    const adminId = (req.user as any)?.id as string | undefined;
    if (!ALLOWED_TYPES.includes(req.body?.type)) {
      return res.status(400).json({ message: 'Tipo inválido', error: 'Bad request' });
    }
    const audienceError = validateAudience(req.body.audience);
    if (audienceError) return res.status(400).json({ message: audienceError, error: 'Bad request' });

    const filters: AudienceFilters = {
      ...req.body.audience,
      type: req.body.type,
      // En prueba, el destinatario es el admin autenticado.
      ...(req.body.audience?.test === true ? { testUserId: adminId } : {}),
    };
    const result = await BroadcastService.previewAudience(filters);
    return res.json({ message: 'Audiencia calculada', data: result });
  } catch (error) {
    logger.error('[Broadcast] Error en preview:', error);
    return res.status(500).json({ message: 'Error calculando audiencia', error: 'Internal server error' });
  }
};

// POST /api/admin/broadcasts/:id/send — dispara el envío real (requiere confirm: true)
export const sendBroadcast = async (req: Request, res: Response) => {
  try {
    if (req.body?.confirm !== true) {
      return res.status(400).json({ message: 'Falta confirm: true', error: 'Confirmation required' });
    }
    const result = await BroadcastService.sendBroadcast(req.params.id);
    return res.json({ message: 'Broadcast enviado', data: result });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Error enviando broadcast';
    logger.error('[Broadcast] Error enviando:', error);
    // Errores de estado/no-encontrado → 400; resto → 500
    const status = /no encontrado|no está en estado/.test(msg) ? 400 : 500;
    return res.status(status).json({ message: msg, error: status === 400 ? 'Bad request' : 'Internal server error' });
  }
};
