import { Request, Response } from 'express';
import { ReminderService, PAYMENT_TYPE_INFO, CreateReminderInput, UpdateReminderInput } from '../services/reminderService';
import { PaymentType } from '@prisma/client';
import { subscriptionService } from '../services/subscriptionService';
import { PLANS } from '../config/stripe';

import { logger } from '../utils/logger';
// Extender Request para incluir usuario autenticado
interface AuthRequest extends Request {
  user?: { id: string; email: string };
}

/**
 * Obtiene todos los recordatorios del usuario
 * GET /api/reminders
 */
export const getReminders = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'No autorizado' });
    }

    const { active } = req.query;
    const activeOnly = active !== 'false';

    const reminders = await ReminderService.getReminders(userId, activeOnly);

    // Enriquecer con información de tipo
    const enrichedReminders = reminders.map(reminder => ({
      ...reminder,
      amount: reminder.amount ? Number(reminder.amount) : null,
      typeInfo: PAYMENT_TYPE_INFO[reminder.type]
    }));

    return res.json({
      success: true,
      reminders: enrichedReminders,
      total: reminders.length
    });

  } catch (error: any) {
    logger.error('[RemindersController] Error getting reminders:', error);
    return res.status(500).json({
      error: 'Error interno',
      message: error.message
    });
  }
};

/**
 * Obtiene un recordatorio por ID
 * GET /api/reminders/:id
 */
export const getReminderById = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'No autorizado' });
    }

    const { id } = req.params;
    const reminder = await ReminderService.getReminderById(id, userId);

    if (!reminder) {
      return res.status(404).json({
        error: 'No encontrado',
        message: 'Recordatorio no encontrado'
      });
    }

    return res.json({
      success: true,
      reminder: {
        ...reminder,
        amount: reminder.amount ? Number(reminder.amount) : null,
        typeInfo: PAYMENT_TYPE_INFO[reminder.type]
      }
    });

  } catch (error: any) {
    logger.error('[RemindersController] Error getting reminder:', error);
    return res.status(500).json({
      error: 'Error interno',
      message: error.message
    });
  }
};

/**
 * Crea un nuevo recordatorio
 * POST /api/reminders
 */
export const createReminder = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'No autorizado' });
    }

    // =============================================
    // VALIDAR LÍMITE DE PLAN
    // =============================================
    const subscription = await subscriptionService.getUserSubscription(userId);
    const planLimits = subscription.limits as { reminders?: number };
    const remindersLimit = planLimits.reminders ?? PLANS.FREE.limits.reminders;

    // Si el límite no es -1 (ilimitado), verificar cantidad actual
    if (remindersLimit !== -1) {
      const currentRemindersCount = await ReminderService.countActiveReminders(userId);

      if (currentRemindersCount >= remindersLimit) {
        return res.status(403).json({
          error: 'Límite de plan alcanzado',
          message: `Tu plan ${subscription.plan} permite máximo ${remindersLimit} recordatorios activos. Mejora a Plus para recordatorios ilimitados.`,
          currentCount: currentRemindersCount,
          limit: remindersLimit,
          upgradeRequired: true
        });
      }
    }

    const { name, type, dueDay, cutoffDay, amount, currency, reminderDays, notifyOnCutoff, notes } = req.body;

    // Validaciones básicas
    if (!name || !dueDay) {
      return res.status(400).json({
        error: 'Validación fallida',
        message: 'El nombre y día de pago son requeridos'
      });
    }

    // Validar tipo de pago
    if (type && !Object.keys(PAYMENT_TYPE_INFO).includes(type)) {
      return res.status(400).json({
        error: 'Validación fallida',
        message: `Tipo de pago inválido. Tipos válidos: ${Object.keys(PAYMENT_TYPE_INFO).join(', ')}`
      });
    }

    const input: CreateReminderInput = {
      name,
      type: type || 'CREDIT_CARD',
      dueDay: parseInt(dueDay),
      cutoffDay: cutoffDay ? parseInt(cutoffDay) : undefined,
      amount: amount ? parseFloat(amount) : undefined,
      currency,
      reminderDays: reminderDays || [3, 1, 0],
      notifyOnCutoff: notifyOnCutoff || false,
      notes
    };

    const reminder = await ReminderService.createReminder(userId, input);

    return res.status(201).json({
      success: true,
      message: 'Recordatorio creado exitosamente',
      reminder: {
        ...reminder,
        amount: reminder.amount ? Number(reminder.amount) : null,
        typeInfo: PAYMENT_TYPE_INFO[reminder.type]
      }
    });

  } catch (error: any) {
    logger.error('[RemindersController] Error creating reminder:', error);
    return res.status(400).json({
      error: 'Error al crear recordatorio',
      message: error.message
    });
  }
};

/**
 * Actualiza un recordatorio
 * PUT /api/reminders/:id
 */
export const updateReminder = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'No autorizado' });
    }

    const { id } = req.params;
    const { name, type, dueDay, cutoffDay, amount, currency, reminderDays, notifyOnCutoff, notes, isActive } = req.body;

    // Validar tipo de pago si se proporciona
    if (type && !Object.keys(PAYMENT_TYPE_INFO).includes(type)) {
      return res.status(400).json({
        error: 'Validación fallida',
        message: `Tipo de pago inválido. Tipos válidos: ${Object.keys(PAYMENT_TYPE_INFO).join(', ')}`
      });
    }

    const input: UpdateReminderInput = {};

    if (name !== undefined) input.name = name;
    if (type !== undefined) input.type = type as PaymentType;
    if (dueDay !== undefined) input.dueDay = parseInt(dueDay);
    if (cutoffDay !== undefined) input.cutoffDay = cutoffDay === null ? null : parseInt(cutoffDay);
    if (amount !== undefined) input.amount = amount === null ? null : parseFloat(amount);
    if (currency !== undefined) input.currency = currency;
    if (reminderDays !== undefined) input.reminderDays = reminderDays;
    if (notifyOnCutoff !== undefined) input.notifyOnCutoff = notifyOnCutoff;
    if (notes !== undefined) input.notes = notes;
    if (isActive !== undefined) input.isActive = isActive;

    const reminder = await ReminderService.updateReminder(id, userId, input);

    return res.json({
      success: true,
      message: 'Recordatorio actualizado exitosamente',
      reminder: {
        ...reminder,
        amount: reminder.amount ? Number(reminder.amount) : null,
        typeInfo: PAYMENT_TYPE_INFO[reminder.type]
      }
    });

  } catch (error: any) {
    logger.error('[RemindersController] Error updating reminder:', error);

    if (error.message === 'Recordatorio no encontrado') {
      return res.status(404).json({
        error: 'No encontrado',
        message: error.message
      });
    }

    return res.status(400).json({
      error: 'Error al actualizar recordatorio',
      message: error.message
    });
  }
};

/**
 * Elimina un recordatorio
 * DELETE /api/reminders/:id
 */
export const deleteReminder = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'No autorizado' });
    }

    const { id } = req.params;
    await ReminderService.deleteReminder(id, userId);

    return res.json({
      success: true,
      message: 'Recordatorio eliminado exitosamente'
    });

  } catch (error: any) {
    logger.error('[RemindersController] Error deleting reminder:', error);

    if (error.message === 'Recordatorio no encontrado') {
      return res.status(404).json({
        error: 'No encontrado',
        message: error.message
      });
    }

    return res.status(500).json({
      error: 'Error al eliminar recordatorio',
      message: error.message
    });
  }
};

/**
 * Obtiene los próximos pagos del usuario
 * GET /api/reminders/upcoming
 */
export const getUpcomingPayments = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'No autorizado' });
    }

    const { days } = req.query;
    const daysAhead = days ? parseInt(days as string) : 30;

    const upcoming = await ReminderService.getUpcomingPayments(userId, daysAhead);

    // Enriquecer con información de tipo
    const enrichedPayments = upcoming.map(payment => ({
      ...payment,
      typeInfo: PAYMENT_TYPE_INFO[payment.type]
    }));

    return res.json({
      success: true,
      upcoming: enrichedPayments,
      total: upcoming.length
    });

  } catch (error: any) {
    logger.error('[RemindersController] Error getting upcoming payments:', error);
    return res.status(500).json({
      error: 'Error interno',
      message: error.message
    });
  }
};

/**
 * Obtiene estadísticas de recordatorios
 * GET /api/reminders/stats
 */
export const getReminderStats = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'No autorizado' });
    }

    const stats = await ReminderService.getReminderStats(userId);

    return res.json({
      success: true,
      stats
    });

  } catch (error: any) {
    logger.error('[RemindersController] Error getting reminder stats:', error);
    return res.status(500).json({
      error: 'Error interno',
      message: error.message
    });
  }
};

/**
 * Obtiene los tipos de pago disponibles
 * GET /api/reminders/types
 */
export const getPaymentTypes = async (_req: Request, res: Response) => {
  try {
    const types = Object.entries(PAYMENT_TYPE_INFO).map(([key, value]) => ({
      value: key,
      label: value.label,
      icon: value.icon
    }));

    return res.json({
      success: true,
      types
    });

  } catch (error: any) {
    logger.error('[RemindersController] Error getting payment types:', error);
    return res.status(500).json({
      error: 'Error interno',
      message: error.message
    });
  }
};

/**
 * Activa o desactiva un recordatorio
 * PATCH /api/reminders/:id/toggle
 */
export const toggleReminder = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'No autorizado' });
    }

    const { id } = req.params;
    const { isActive } = req.body;

    if (typeof isActive !== 'boolean') {
      return res.status(400).json({
        error: 'Validación fallida',
        message: 'El campo isActive debe ser un booleano'
      });
    }

    // =============================================
    // VALIDAR LÍMITE DE PLAN AL ACTIVAR
    // =============================================
    if (isActive) {
      const subscription = await subscriptionService.getUserSubscription(userId);
      const planLimits = subscription.limits as { reminders?: number };
      const remindersLimit = planLimits.reminders ?? PLANS.FREE.limits.reminders;

      if (remindersLimit !== -1) {
        const currentRemindersCount = await ReminderService.countActiveReminders(userId);

        if (currentRemindersCount >= remindersLimit) {
          return res.status(403).json({
            error: 'Límite de plan alcanzado',
            message: `Tu plan ${subscription.plan} permite máximo ${remindersLimit} recordatorios activos. Mejora a Plus para recordatorios ilimitados.`,
            currentCount: currentRemindersCount,
            limit: remindersLimit,
            upgradeRequired: true
          });
        }
      }
    }

    const reminder = await ReminderService.updateReminder(id, userId, { isActive });

    return res.json({
      success: true,
      message: isActive ? 'Recordatorio activado' : 'Recordatorio desactivado',
      reminder: {
        id: reminder.id,
        name: reminder.name,
        isActive: reminder.isActive
      }
    });

  } catch (error: any) {
    logger.error('[RemindersController] Error toggling reminder:', error);

    if (error.message === 'Recordatorio no encontrado') {
      return res.status(404).json({
        error: 'No encontrado',
        message: error.message
      });
    }

    return res.status(500).json({
      error: 'Error al cambiar estado',
      message: error.message
    });
  }
};

export default {
  getReminders,
  getReminderById,
  createReminder,
  updateReminder,
  deleteReminder,
  getUpcomingPayments,
  getReminderStats,
  getPaymentTypes,
  toggleReminder
};
