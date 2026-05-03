import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { logger } from '../utils/logger';
import { sendFeedbackNotification } from '../services/emailService';
import type { FeedbackType, FeedbackStatus } from '@prisma/client';

// Validación de módulos permitidos. String libre en DB pero acotado en código
// para que cualquier feedback con valor inválido se rechace antes de persistir.
const ALLOWED_MODULES = new Set([
  'dashboard',
  'transactions',
  'budgets',
  'goals',
  'zenio',
  'tools',
  'subscriptions',
  'email_sync',
  'notifications',
  'gamification',
  'auth',
  'other',
]);

const ALLOWED_TYPES = new Set<FeedbackType>(['BUG', 'SUGGESTION', 'OTHER']);
const ALLOWED_PLATFORMS = new Set(['ios', 'android']);

const MIN_MESSAGE_LENGTH = 10;
const MAX_MESSAGE_LENGTH = 2000;

/**
 * POST /api/feedback
 * Recibe feedback del usuario autenticado (bug/sugerencia/otro).
 * Si el tipo es BUG, dispara notificación email a info@finzenai.com (best-effort).
 */
export const submitFeedback = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'No autenticado' });
    }

    const { type, module, message, appVersion, platform } = req.body ?? {};

    // Validación tipo
    if (typeof type !== 'string' || !ALLOWED_TYPES.has(type as FeedbackType)) {
      return res.status(400).json({
        error: 'Tipo de feedback inválido. Usa BUG, SUGGESTION u OTHER.',
      });
    }

    // Validación mensaje
    if (typeof message !== 'string') {
      return res.status(400).json({ error: 'El mensaje es requerido.' });
    }
    const trimmedMessage = message.trim();
    if (trimmedMessage.length < MIN_MESSAGE_LENGTH) {
      return res.status(400).json({
        error: `El mensaje debe tener al menos ${MIN_MESSAGE_LENGTH} caracteres.`,
      });
    }
    if (trimmedMessage.length > MAX_MESSAGE_LENGTH) {
      return res.status(400).json({
        error: `El mensaje no puede exceder ${MAX_MESSAGE_LENGTH} caracteres.`,
      });
    }

    // Módulo opcional pero validado si viene
    let cleanModule: string | null = null;
    if (module !== undefined && module !== null && module !== '') {
      if (typeof module !== 'string' || !ALLOWED_MODULES.has(module)) {
        return res.status(400).json({ error: 'Módulo inválido.' });
      }
      cleanModule = module;
    }

    // Platform opcional pero validado si viene
    let cleanPlatform: string | null = null;
    if (platform !== undefined && platform !== null && platform !== '') {
      if (typeof platform !== 'string' || !ALLOWED_PLATFORMS.has(platform)) {
        return res.status(400).json({ error: 'Platform inválido.' });
      }
      cleanPlatform = platform;
    }

    // appVersion opcional, máximo 20 chars
    let cleanAppVersion: string | null = null;
    if (typeof appVersion === 'string' && appVersion.trim() !== '') {
      cleanAppVersion = appVersion.trim().slice(0, 20);
    }

    // Persistir
    const feedback = await prisma.feedback.create({
      data: {
        userId,
        type: type as FeedbackType,
        module: cleanModule,
        message: trimmedMessage,
        appVersion: cleanAppVersion,
        platform: cleanPlatform,
      },
      include: {
        user: { select: { name: true, lastName: true, email: true } },
      },
    });

    logger.log(`[Feedback] Recibido: ${feedback.id} (${type}, ${cleanModule ?? 'sin módulo'}) de ${feedback.user.email}`);

    // Solo BUGs disparan email — sugerencias/otros solo persisten
    if (type === 'BUG') {
      void sendFeedbackNotification({
        feedbackId: feedback.id,
        userName: `${feedback.user.name} ${feedback.user.lastName}`,
        userEmail: feedback.user.email,
        type: type,
        module: cleanModule,
        message: trimmedMessage,
        appVersion: cleanAppVersion,
        platform: cleanPlatform,
        createdAt: feedback.createdAt,
      }).catch((err) => {
        logger.error('[Feedback] Error enviando notificación email:', err);
      });
    }

    return res.status(201).json({
      success: true,
      feedbackId: feedback.id,
      message: '¡Gracias por tu feedback! Lo revisaremos pronto.',
    });
  } catch (error) {
    logger.error('[Feedback] Error al enviar:', error);
    return res.status(500).json({
      error: 'Error del servidor. Por favor intenta nuevamente.',
    });
  }
};

/**
 * GET /api/admin/feedback
 * Lista todos los feedback con filtros opcionales (status, type, module, search).
 * Solo admin.
 */
export const getFeedbackList = async (req: Request, res: Response) => {
  try {
    const { status, type, module, search, limit, offset } = req.query;

    const where: {
      status?: FeedbackStatus;
      type?: FeedbackType;
      module?: string;
      message?: { contains: string; mode: 'insensitive' };
    } = {};

    if (typeof status === 'string' && ['NEW', 'REVIEWED', 'RESOLVED', 'WONT_FIX'].includes(status)) {
      where.status = status as FeedbackStatus;
    }
    if (typeof type === 'string' && ALLOWED_TYPES.has(type as FeedbackType)) {
      where.type = type as FeedbackType;
    }
    if (typeof module === 'string' && ALLOWED_MODULES.has(module)) {
      where.module = module;
    }
    if (typeof search === 'string' && search.trim() !== '') {
      where.message = { contains: search.trim(), mode: 'insensitive' };
    }

    const take = Math.min(parseInt(typeof limit === 'string' ? limit : '50', 10) || 50, 200);
    const skip = parseInt(typeof offset === 'string' ? offset : '0', 10) || 0;

    const [items, total] = await Promise.all([
      prisma.feedback.findMany({
        where,
        include: {
          user: {
            select: { id: true, name: true, lastName: true, email: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        take,
        skip,
      }),
      prisma.feedback.count({ where }),
    ]);

    return res.json({ items, total, limit: take, offset: skip });
  } catch (error) {
    logger.error('[Feedback] Error listando admin:', error);
    return res.status(500).json({ error: 'Error del servidor.' });
  }
};

/**
 * PATCH /api/admin/feedback/:id
 * Actualiza el status y/o adminResponse de un feedback. Solo admin.
 */
export const updateFeedback = async (req: Request, res: Response) => {
  try {
    const adminEmail = req.user?.email;
    if (!adminEmail) {
      return res.status(401).json({ error: 'No autenticado' });
    }

    const { id } = req.params;
    const { status, adminResponse } = req.body ?? {};

    if (typeof id !== 'string' || id.length === 0) {
      return res.status(400).json({ error: 'ID inválido.' });
    }

    const data: {
      status?: FeedbackStatus;
      adminResponse?: string | null;
      reviewedAt?: Date;
      reviewedBy?: string;
    } = {};

    if (status !== undefined) {
      if (typeof status !== 'string' || !['NEW', 'REVIEWED', 'RESOLVED', 'WONT_FIX'].includes(status)) {
        return res.status(400).json({ error: 'Status inválido.' });
      }
      data.status = status as FeedbackStatus;
    }

    if (adminResponse !== undefined) {
      if (adminResponse !== null && (typeof adminResponse !== 'string' || adminResponse.length > MAX_MESSAGE_LENGTH)) {
        return res.status(400).json({ error: 'Respuesta inválida.' });
      }
      data.adminResponse = adminResponse;
    }

    if (Object.keys(data).length === 0) {
      return res.status(400).json({ error: 'No hay campos para actualizar.' });
    }

    // Marcar quién y cuándo revisó
    data.reviewedAt = new Date();
    data.reviewedBy = adminEmail;

    const updated = await prisma.feedback.update({
      where: { id },
      data,
      include: {
        user: { select: { id: true, name: true, lastName: true, email: true } },
      },
    });

    return res.json(updated);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'P2025') {
      return res.status(404).json({ error: 'Feedback no encontrado.' });
    }
    logger.error('[Feedback] Error actualizando:', error);
    return res.status(500).json({ error: 'Error del servidor.' });
  }
};
