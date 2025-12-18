import { Request, Response } from 'express';
import { DevicePlatform } from '@prisma/client';
import NotificationService from '../services/notificationService';

interface AuthRequest extends Request {
  userId?: string;
}

interface RegisterDeviceRequest {
  fcmToken: string;
  platform: 'ANDROID' | 'IOS';
  deviceName?: string;
  appVersion?: string;
}

interface UpdatePreferencesRequest {
  emailSyncEnabled?: boolean;
  budgetAlertsEnabled?: boolean;
  goalRemindersEnabled?: boolean;
  weeklyReportEnabled?: boolean;
  tipsEnabled?: boolean;
  budgetAlertThreshold?: number;
  quietHoursStart?: number | null;
  quietHoursEnd?: number | null;
}

/**
 * Registra un dispositivo para recibir notificaciones push
 * POST /api/notifications/device
 */
export const registerDevice = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { fcmToken, platform, deviceName, appVersion }: RegisterDeviceRequest = req.body;

    if (!fcmToken || !platform) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'fcmToken y platform son requeridos'
      });
    }

    if (!['ANDROID', 'IOS'].includes(platform)) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'platform debe ser ANDROID o IOS'
      });
    }

    const result = await NotificationService.registerDevice(
      userId,
      fcmToken,
      platform as DevicePlatform,
      deviceName,
      appVersion
    );

    if (!result.success) {
      return res.status(500).json({
        error: 'Registration failed',
        message: result.error
      });
    }

    return res.status(200).json({
      success: true,
      deviceId: result.deviceId,
      message: 'Dispositivo registrado correctamente'
    });

  } catch (error: any) {
    console.error('[NotificationsController] Error registering device:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
};

/**
 * Desregistra un dispositivo (logout o desinstalar app)
 * DELETE /api/notifications/device
 */
export const unregisterDevice = async (req: AuthRequest, res: Response) => {
  try {
    const { fcmToken } = req.body;

    if (!fcmToken) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'fcmToken es requerido'
      });
    }

    const success = await NotificationService.unregisterDevice(fcmToken);

    return res.status(200).json({
      success,
      message: success ? 'Dispositivo desregistrado' : 'No se encontró el dispositivo'
    });

  } catch (error: any) {
    console.error('[NotificationsController] Error unregistering device:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
};

/**
 * Obtiene las preferencias de notificación del usuario
 * GET /api/notifications/preferences
 */
export const getPreferences = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const preferences = await NotificationService.getPreferences(userId);

    if (!preferences) {
      // Retornar valores por defecto si no existen
      return res.status(200).json({
        emailSyncEnabled: true,
        budgetAlertsEnabled: true,
        goalRemindersEnabled: true,
        weeklyReportEnabled: true,
        tipsEnabled: true,
        budgetAlertThreshold: 80,
        quietHoursStart: null,
        quietHoursEnd: null
      });
    }

    return res.status(200).json({
      emailSyncEnabled: preferences.emailSyncEnabled,
      budgetAlertsEnabled: preferences.budgetAlertsEnabled,
      goalRemindersEnabled: preferences.goalRemindersEnabled,
      weeklyReportEnabled: preferences.weeklyReportEnabled,
      tipsEnabled: preferences.tipsEnabled,
      budgetAlertThreshold: preferences.budgetAlertThreshold,
      quietHoursStart: preferences.quietHoursStart,
      quietHoursEnd: preferences.quietHoursEnd
    });

  } catch (error: any) {
    console.error('[NotificationsController] Error getting preferences:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
};

/**
 * Actualiza las preferencias de notificación del usuario
 * PUT /api/notifications/preferences
 */
export const updatePreferences = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const updates: UpdatePreferencesRequest = req.body;

    // Validar budgetAlertThreshold si se proporciona
    if (updates.budgetAlertThreshold !== undefined) {
      if (updates.budgetAlertThreshold < 0 || updates.budgetAlertThreshold > 100) {
        return res.status(400).json({
          error: 'Validation error',
          message: 'budgetAlertThreshold debe estar entre 0 y 100'
        });
      }
    }

    // Validar quiet hours si se proporcionan
    if (updates.quietHoursStart !== undefined && updates.quietHoursStart !== null) {
      if (updates.quietHoursStart < 0 || updates.quietHoursStart > 23) {
        return res.status(400).json({
          error: 'Validation error',
          message: 'quietHoursStart debe estar entre 0 y 23'
        });
      }
    }

    if (updates.quietHoursEnd !== undefined && updates.quietHoursEnd !== null) {
      if (updates.quietHoursEnd < 0 || updates.quietHoursEnd > 23) {
        return res.status(400).json({
          error: 'Validation error',
          message: 'quietHoursEnd debe estar entre 0 y 23'
        });
      }
    }

    const preferences = await NotificationService.updatePreferences(userId, updates);

    return res.status(200).json({
      success: true,
      message: 'Preferencias actualizadas',
      preferences: {
        emailSyncEnabled: preferences.emailSyncEnabled,
        budgetAlertsEnabled: preferences.budgetAlertsEnabled,
        goalRemindersEnabled: preferences.goalRemindersEnabled,
        weeklyReportEnabled: preferences.weeklyReportEnabled,
        tipsEnabled: preferences.tipsEnabled,
        budgetAlertThreshold: preferences.budgetAlertThreshold,
        quietHoursStart: preferences.quietHoursStart,
        quietHoursEnd: preferences.quietHoursEnd
      }
    });

  } catch (error: any) {
    console.error('[NotificationsController] Error updating preferences:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
};

/**
 * Obtiene el historial de notificaciones del usuario
 * GET /api/notifications/history
 */
export const getNotificationHistory = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const limit = parseInt(req.query.limit as string) || 50;
    const notifications = await NotificationService.getNotificationHistory(userId, Math.min(limit, 100));

    return res.status(200).json({
      notifications: notifications.map(n => ({
        id: n.id,
        type: n.type,
        title: n.title,
        body: n.body,
        data: n.data,
        status: n.status,
        sentAt: n.sentAt,
        readAt: n.readAt,
        createdAt: n.createdAt
      }))
    });

  } catch (error: any) {
    console.error('[NotificationsController] Error getting history:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
};

/**
 * Marca una notificación como leída
 * PUT /api/notifications/:id/read
 */
export const markAsRead = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { id } = req.params;

    const notification = await NotificationService.markAsRead(id);

    return res.status(200).json({
      success: true,
      notification: {
        id: notification.id,
        status: notification.status,
        readAt: notification.readAt
      }
    });

  } catch (error: any) {
    console.error('[NotificationsController] Error marking as read:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
};

/**
 * Elimina una notificación específica
 * DELETE /api/notifications/:id
 */
export const deleteNotification = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { id } = req.params;

    const deleted = await NotificationService.deleteNotification(id, userId);

    if (!deleted) {
      return res.status(404).json({
        error: 'Not found',
        message: 'Notificación no encontrada o no tienes permiso para eliminarla'
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Notificación eliminada'
    });

  } catch (error: any) {
    console.error('[NotificationsController] Error deleting notification:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
};

/**
 * Elimina todas las notificaciones del usuario
 * DELETE /api/notifications/all
 */
export const deleteAllNotifications = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const count = await NotificationService.deleteAllNotifications(userId);

    return res.status(200).json({
      success: true,
      message: `${count} notificaciones eliminadas`,
      deletedCount: count
    });

  } catch (error: any) {
    console.error('[NotificationsController] Error deleting all notifications:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
};

/**
 * Endpoint de prueba para enviar una notificación (solo desarrollo)
 * POST /api/notifications/test
 */
export const sendTestNotification = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Solo permitir en desarrollo
    if (process.env.NODE_ENV === 'production') {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'Test notifications not available in production'
      });
    }

    const result = await NotificationService.sendToUser(userId, 'SYSTEM', {
      title: '🔔 Notificación de prueba',
      body: 'Si ves esto, las notificaciones están funcionando correctamente',
      data: {
        type: 'TEST',
        timestamp: new Date().toISOString()
      }
    });

    return res.status(200).json({
      success: result.success,
      successCount: result.successCount,
      failureCount: result.failureCount,
      errors: result.errors
    });

  } catch (error: any) {
    console.error('[NotificationsController] Error sending test:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
};
