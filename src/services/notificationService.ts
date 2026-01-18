import admin from 'firebase-admin';
import { NotificationType, NotificationStatus, DevicePlatform } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { subscriptionService } from './subscriptionService';
import { PLANS } from '../config/stripe';

import { logger } from '../utils/logger';
// Inicializar Firebase Admin SDK
let firebaseInitialized = false;

const initializeFirebase = () => {
  if (firebaseInitialized) return;

  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT;

  if (!serviceAccount) {
    logger.warn('[NotificationService] FIREBASE_SERVICE_ACCOUNT not configured - push notifications disabled');
    return;
  }

  try {
    const credentials = JSON.parse(serviceAccount);
    admin.initializeApp({
      credential: admin.credential.cert(credentials)
    });
    firebaseInitialized = true;
    logger.log('[NotificationService] Firebase Admin initialized successfully');
  } catch (error) {
    logger.error('[NotificationService] Failed to initialize Firebase:', error);
  }
};

// Inicializar al cargar el módulo
initializeFirebase();

export interface NotificationPayload {
  title: string;
  body: string;
  data?: Record<string, string>;
  imageUrl?: string;
}

export interface SendNotificationResult {
  success: boolean;
  successCount: number;
  failureCount: number;
  errors?: string[];
}

export class NotificationService {

  /**
   * Registra o actualiza un dispositivo para recibir notificaciones
   */
  static async registerDevice(
    userId: string,
    fcmToken: string,
    platform: DevicePlatform,
    deviceName?: string,
    appVersion?: string
  ): Promise<{ success: boolean; deviceId?: string; error?: string }> {
    try {
      // Verificar si el token ya existe para otro usuario
      const existingDevice = await prisma.userDevice.findUnique({
        where: { fcmToken }
      });

      if (existingDevice && existingDevice.userId !== userId) {
        // El token pertenece a otro usuario, lo desactivamos
        await prisma.userDevice.update({
          where: { id: existingDevice.id },
          data: { isActive: false }
        });
      }

      // Crear o actualizar el dispositivo
      const device = await prisma.userDevice.upsert({
        where: { fcmToken },
        update: {
          userId,
          platform,
          deviceName,
          appVersion,
          isActive: true,
          lastUsedAt: new Date()
        },
        create: {
          userId,
          fcmToken,
          platform,
          deviceName,
          appVersion,
          isActive: true
        }
      });

      // Crear preferencias de notificación si no existen
      await prisma.notificationPreferences.upsert({
        where: { userId },
        update: {},
        create: {
          userId,
          emailSyncEnabled: true,
          budgetAlertsEnabled: true,
          goalRemindersEnabled: true,
          weeklyReportEnabled: true,
          tipsEnabled: true,
          budgetAlertThreshold: 80,
          antExpenseAlertsEnabled: true,
          antExpenseAlertThreshold: 20,
          trialNotificationsEnabled: true
        }
      });

      logger.log(`[NotificationService] Device registered for user ${userId}: ${device.id}`);
      return { success: true, deviceId: device.id };

    } catch (error: any) {
      logger.error('[NotificationService] Error registering device:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Desregistra un dispositivo
   */
  static async unregisterDevice(fcmToken: string): Promise<boolean> {
    try {
      await prisma.userDevice.updateMany({
        where: { fcmToken },
        data: { isActive: false }
      });
      return true;
    } catch (error) {
      logger.error('[NotificationService] Error unregistering device:', error);
      return false;
    }
  }

  /**
   * Envía una notificación a un usuario específico
   */
  static async sendToUser(
    userId: string,
    type: NotificationType,
    payload: NotificationPayload
  ): Promise<SendNotificationResult> {
    try {
      if (!firebaseInitialized) {
        logger.warn('[NotificationService] Firebase not initialized, skipping notification');
        return { success: false, successCount: 0, failureCount: 1, errors: ['Firebase not initialized'] };
      }

      // Verificar preferencias del usuario
      const preferences = await prisma.notificationPreferences.findUnique({
        where: { userId }
      });

      if (preferences && !this.isNotificationTypeEnabled(preferences, type)) {
        logger.log(`[NotificationService] User ${userId} has disabled ${type} notifications`);
        return { success: true, successCount: 0, failureCount: 0 };
      }

      // Verificar horario silencioso
      if (preferences && this.isInQuietHours(preferences)) {
        logger.log(`[NotificationService] User ${userId} is in quiet hours, skipping notification`);
        return { success: true, successCount: 0, failureCount: 0 };
      }

      // Obtener dispositivos activos del usuario
      const devices = await prisma.userDevice.findMany({
        where: {
          userId,
          isActive: true
        }
      });

      if (devices.length === 0) {
        logger.log(`[NotificationService] No active devices for user ${userId}`);
        return { success: true, successCount: 0, failureCount: 0 };
      }

      const tokens = devices.map(d => d.fcmToken);
      const result = await this.sendMulticast(tokens, payload);

      // Registrar la notificación
      await this.logNotification(userId, type, payload, result.successCount > 0 ? 'SENT' : 'FAILED');

      // Limpiar tokens inválidos
      if (result.failedTokens && result.failedTokens.length > 0) {
        await this.cleanupInvalidTokens(result.failedTokens);
      }

      return {
        success: result.successCount > 0,
        successCount: result.successCount,
        failureCount: result.failureCount,
        errors: result.errors
      };

    } catch (error: any) {
      logger.error('[NotificationService] Error sending notification to user:', error);
      await this.logNotification(userId, type, payload, 'FAILED', error.message);
      return { success: false, successCount: 0, failureCount: 1, errors: [error.message] };
    }
  }

  /**
   * Envía una notificación DIRECTAMENTE sin verificar preferencias ni horarios
   * SOLO PARA TESTING/DESARROLLO
   */
  static async sendDirectNotification(
    userId: string,
    payload: NotificationPayload
  ): Promise<SendNotificationResult> {
    try {
      if (!firebaseInitialized) {
        logger.warn('[NotificationService] Firebase not initialized');
        return { success: false, successCount: 0, failureCount: 1, errors: ['Firebase not initialized'] };
      }

      // Obtener dispositivos activos del usuario
      const devices = await prisma.userDevice.findMany({
        where: {
          userId,
          isActive: true
        }
      });

      if (devices.length === 0) {
        logger.warn(`[NotificationService] No active devices for user ${userId}`);
        return { success: false, successCount: 0, failureCount: 0, errors: ['No hay dispositivos registrados'] };
      }

      logger.log(`[NotificationService] Enviando notificación directa a ${devices.length} dispositivo(s)...`);

      const tokens = devices.map(d => d.fcmToken);
      const result = await this.sendMulticast(tokens, payload);

      // Guardar en historial para que aparezca en la campanita
      await this.logNotification(userId, 'TIP', payload, result.successCount > 0 ? 'SENT' : 'FAILED');

      // Limpiar tokens inválidos
      if (result.failedTokens && result.failedTokens.length > 0) {
        await this.cleanupInvalidTokens(result.failedTokens);
      }

      return {
        success: result.successCount > 0,
        successCount: result.successCount,
        failureCount: result.failureCount,
        errors: result.errors
      };

    } catch (error: any) {
      logger.error('[NotificationService] Error sending direct notification:', error);
      return { success: false, successCount: 0, failureCount: 1, errors: [error.message] };
    }
  }

  /**
   * Envía notificación multicast a múltiples tokens
   */
  private static async sendMulticast(
    tokens: string[],
    payload: NotificationPayload
  ): Promise<{ successCount: number; failureCount: number; errors?: string[]; failedTokens?: string[] }> {
    try {
      const message: admin.messaging.MulticastMessage = {
        tokens,
        notification: {
          title: payload.title,
          body: payload.body,
          ...(payload.imageUrl && { imageUrl: payload.imageUrl })
        },
        data: payload.data,
        android: {
          priority: 'high',
          notification: {
            channelId: 'finzenai_notifications',
            priority: 'high',
            defaultSound: true,
            defaultVibrateTimings: true,
            visibility: 'public',
            notificationCount: 1,
            sticky: true
          }
        },
        apns: {
          payload: {
            aps: {
              alert: {
                title: payload.title,
                body: payload.body
              },
              sound: 'default',
              badge: 1
            }
          }
        }
      };

      const response = await admin.messaging().sendEachForMulticast(message);

      const errors: string[] = [];
      const failedTokens: string[] = [];

      response.responses.forEach((resp, idx) => {
        if (!resp.success && resp.error) {
          errors.push(resp.error.message);
          failedTokens.push(tokens[idx]);
        }
      });

      logger.log(`[NotificationService] Multicast result: ${response.successCount} success, ${response.failureCount} failures`);

      return {
        successCount: response.successCount,
        failureCount: response.failureCount,
        errors: errors.length > 0 ? errors : undefined,
        failedTokens: failedTokens.length > 0 ? failedTokens : undefined
      };

    } catch (error: any) {
      logger.error('[NotificationService] Multicast error:', error);
      return { successCount: 0, failureCount: tokens.length, errors: [error.message] };
    }
  }

  /**
   * Verifica si el tipo de notificación está habilitado
   */
  private static isNotificationTypeEnabled(preferences: any, type: NotificationType): boolean {
    switch (type) {
      case 'EMAIL_SYNC_COMPLETE':
        return preferences.emailSyncEnabled;
      case 'BUDGET_ALERT':
      case 'BUDGET_EXCEEDED':
        return preferences.budgetAlertsEnabled;
      case 'GOAL_REMINDER':
      case 'GOAL_ACHIEVED':
        return preferences.goalRemindersEnabled;
      case 'WEEKLY_REPORT':
        return preferences.weeklyReportEnabled;
      case 'TIP':
        return preferences.tipsEnabled;
      case 'PAYMENT_REMINDER':
      case 'PAYMENT_DUE_TODAY':
      case 'PAYMENT_OVERDUE':
        return preferences.paymentRemindersEnabled ?? true;
      case 'ANT_EXPENSE_ALERT':
        return preferences.antExpenseAlertsEnabled ?? true;
      case 'TRIAL_WELCOME':
      case 'TRIAL_DAY_3':
      case 'TRIAL_DAY_5':
      case 'TRIAL_ENDING':
      case 'TRIAL_ENDED':
        return preferences.trialNotificationsEnabled ?? true;
      case 'SYSTEM':
        return true; // System notifications always enabled
      default:
        return true;
    }
  }

  /**
   * Verifica si está en horario silencioso
   */
  private static isInQuietHours(preferences: any): boolean {
    if (!preferences.quietHoursStart || !preferences.quietHoursEnd) {
      return false;
    }

    const now = new Date();
    const currentHour = now.getHours();
    const start = preferences.quietHoursStart;
    const end = preferences.quietHoursEnd;

    // Maneja el caso cuando el período cruza la medianoche
    if (start > end) {
      return currentHour >= start || currentHour < end;
    }
    return currentHour >= start && currentHour < end;
  }

  /**
   * Registra una notificación en el historial
   */
  private static async logNotification(
    userId: string,
    type: NotificationType,
    payload: NotificationPayload,
    status: NotificationStatus,
    errorMessage?: string
  ): Promise<void> {
    try {
      await prisma.notificationLog.create({
        data: {
          userId,
          type,
          title: payload.title,
          body: payload.body,
          data: payload.data,
          status,
          sentAt: status === 'SENT' ? new Date() : null,
          errorMessage
        }
      });
    } catch (error) {
      logger.error('[NotificationService] Error logging notification:', error);
    }
  }

  /**
   * Limpia tokens inválidos de la base de datos
   */
  private static async cleanupInvalidTokens(tokens: string[]): Promise<void> {
    try {
      await prisma.userDevice.updateMany({
        where: { fcmToken: { in: tokens } },
        data: { isActive: false }
      });
      logger.log(`[NotificationService] Deactivated ${tokens.length} invalid tokens`);
    } catch (error) {
      logger.error('[NotificationService] Error cleaning up invalid tokens:', error);
    }
  }

  // =============================================
  // MÉTODOS DE NOTIFICACIONES ESPECÍFICAS
  // =============================================

  /**
   * Notifica que la sincronización de email se completó
   */
  static async notifyEmailSyncComplete(
    userId: string,
    transactionsImported: number
  ): Promise<SendNotificationResult> {
    const payload: NotificationPayload = {
      title: 'Sincronización completada',
      body: transactionsImported > 0
        ? `Se importaron ${transactionsImported} transacciones de tus emails bancarios`
        : 'No se encontraron nuevas transacciones en tus emails',
      data: {
        type: 'EMAIL_SYNC_COMPLETE',
        transactionsImported: transactionsImported.toString(),
        screen: 'Dashboard'
      }
    };

    return this.sendToUser(userId, 'EMAIL_SYNC_COMPLETE', payload);
  }

  /**
   * Notifica alerta de presupuesto (umbral alcanzado)
   */
  static async notifyBudgetAlert(
    userId: string,
    budgetName: string,
    percentageUsed: number,
    amountRemaining: number,
    currency: string
  ): Promise<SendNotificationResult> {
    const payload: NotificationPayload = {
      title: '⚠️ Alerta de presupuesto',
      body: `Has usado el ${percentageUsed}% de tu presupuesto "${budgetName}". Te quedan ${currency}${amountRemaining.toFixed(2)}`,
      data: {
        type: 'BUDGET_ALERT',
        budgetName,
        percentageUsed: percentageUsed.toString(),
        screen: 'Budgets'
      }
    };

    return this.sendToUser(userId, 'BUDGET_ALERT', payload);
  }

  /**
   * Notifica que se excedió un presupuesto
   */
  static async notifyBudgetExceeded(
    userId: string,
    budgetName: string,
    amountExceeded: number,
    currency: string
  ): Promise<SendNotificationResult> {
    const payload: NotificationPayload = {
      title: '🚨 Presupuesto excedido',
      body: `Has excedido tu presupuesto "${budgetName}" por ${currency}${amountExceeded.toFixed(2)}`,
      data: {
        type: 'BUDGET_EXCEEDED',
        budgetName,
        amountExceeded: amountExceeded.toString(),
        screen: 'Budgets'
      }
    };

    return this.sendToUser(userId, 'BUDGET_EXCEEDED', payload);
  }

  /**
   * Notifica recordatorio de meta
   */
  static async notifyGoalReminder(
    userId: string,
    goalName: string,
    percentageComplete: number,
    amountRemaining: number,
    currency: string
  ): Promise<SendNotificationResult> {
    const payload: NotificationPayload = {
      title: '🎯 Recordatorio de meta',
      body: `Tu meta "${goalName}" está al ${percentageComplete}%. Faltan ${currency}${amountRemaining.toFixed(2)} para completarla`,
      data: {
        type: 'GOAL_REMINDER',
        goalName,
        percentageComplete: percentageComplete.toString(),
        screen: 'Goals'
      }
    };

    return this.sendToUser(userId, 'GOAL_REMINDER', payload);
  }

  /**
   * Notifica que se completó una meta
   */
  static async notifyGoalAchieved(
    userId: string,
    goalName: string
  ): Promise<SendNotificationResult> {
    const payload: NotificationPayload = {
      title: '🎉 ¡Meta alcanzada!',
      body: `¡Felicitaciones! Has completado tu meta "${goalName}"`,
      data: {
        type: 'GOAL_ACHIEVED',
        goalName,
        screen: 'Goals'
      }
    };

    return this.sendToUser(userId, 'GOAL_ACHIEVED', payload);
  }

  /**
   * Notifica reporte semanal disponible
   */
  static async notifyWeeklyReport(
    userId: string,
    totalSpent: number,
    currency: string,
    topCategory?: string
  ): Promise<SendNotificationResult> {
    const body = topCategory
      ? `Esta semana gastaste ${currency}${totalSpent.toFixed(2)}. Tu mayor categoría fue ${topCategory}`
      : `Esta semana gastaste ${currency}${totalSpent.toFixed(2)}. Revisa tu resumen completo`;

    const payload: NotificationPayload = {
      title: '📊 Tu resumen semanal',
      body,
      data: {
        type: 'WEEKLY_REPORT',
        totalSpent: totalSpent.toString(),
        screen: 'Dashboard'
      }
    };

    return this.sendToUser(userId, 'WEEKLY_REPORT', payload);
  }

  /**
   * Envía un tip financiero
   */
  static async notifyTip(
    userId: string,
    tipTitle: string,
    tipContent: string
  ): Promise<SendNotificationResult> {
    const payload: NotificationPayload = {
      title: `💡 ${tipTitle}`,
      body: tipContent,
      data: {
        type: 'TIP',
        screen: 'Dashboard'
      }
    };

    return this.sendToUser(userId, 'TIP', payload);
  }

  /**
   * Notifica alerta de gastos hormiga (análisis semanal)
   */
  static async notifyAntExpenseAlert(
    userId: string,
    totalAntExpenses: number,
    percentageOfTotal: number,
    topCategory: string,
    savingsOpportunity: number,
    currency: string
  ): Promise<SendNotificationResult> {
    const payload: NotificationPayload = {
      title: '🐜 ¡Alerta de Gastos Hormiga!',
      body: `Tus pequeños gastos suman ${currency}${totalAntExpenses.toLocaleString()} (${percentageOfTotal}% del total). Tu mayor "criminal" es ${topCategory}. ¡Podrías ahorrar ${currency}${savingsOpportunity.toLocaleString()}/mes!`,
      data: {
        type: 'ANT_EXPENSE_ALERT',
        totalAntExpenses: totalAntExpenses.toString(),
        percentageOfTotal: percentageOfTotal.toString(),
        topCategory,
        savingsOpportunity: savingsOpportunity.toString(),
        screen: 'AntExpenseDetective'
      }
    };

    return this.sendToUser(userId, 'ANT_EXPENSE_ALERT', payload);
  }

  // =============================================
  // NOTIFICACIONES DE TRIAL
  // =============================================

  /**
   * Notifica bienvenida al trial (Día 1)
   */
  static async notifyTrialWelcome(
    userId: string,
    userName: string
  ): Promise<SendNotificationResult> {
    const payload: NotificationPayload = {
      title: '🎉 ¡Bienvenido a FinZen PRO!',
      body: `¡Hola ${userName}! Tu prueba gratuita de 7 días ha comenzado. Explora todas las funciones premium: análisis de gastos hormiga, alertas inteligentes, exportación de datos y más.`,
      data: {
        type: 'TRIAL_WELCOME',
        screen: 'Dashboard'
      }
    };

    return this.sendToUser(userId, 'TRIAL_WELCOME', payload);
  }

  /**
   * Notifica recordatorio de trial (Día 3)
   */
  static async notifyTrialDay3(
    userId: string
  ): Promise<SendNotificationResult> {
    const payload: NotificationPayload = {
      title: '📊 ¿Ya exploraste tus finanzas?',
      body: '¡Llevas 3 días de prueba! ¿Ya creaste tu primer presupuesto? Configura alertas para no exceder tus límites. Te quedan 4 días de acceso premium.',
      data: {
        type: 'TRIAL_DAY_3',
        screen: 'Budgets'
      }
    };

    return this.sendToUser(userId, 'TRIAL_DAY_3', payload);
  }

  /**
   * Notifica recordatorio de trial (Día 5)
   */
  static async notifyTrialDay5(
    userId: string
  ): Promise<SendNotificationResult> {
    const payload: NotificationPayload = {
      title: '⏰ ¡Te quedan 2 días!',
      body: 'Tu prueba premium termina pronto. Usa el detector de gastos hormiga para descubrir dónde se va tu dinero. ¡No pierdas estas funciones!',
      data: {
        type: 'TRIAL_DAY_5',
        screen: 'AntExpenseDetective'
      }
    };

    return this.sendToUser(userId, 'TRIAL_DAY_5', payload);
  }

  /**
   * Notifica que el trial está por terminar (Día 7)
   */
  static async notifyTrialEnding(
    userId: string
  ): Promise<SendNotificationResult> {
    const payload: NotificationPayload = {
      title: '🔔 Tu prueba termina hoy',
      body: '¡Último día de acceso premium! Suscríbete ahora para mantener todas las funciones: análisis ilimitado, alertas inteligentes, exportación y más desde $4.99/mes.',
      data: {
        type: 'TRIAL_ENDING',
        screen: 'Subscriptions'
      }
    };

    return this.sendToUser(userId, 'TRIAL_ENDING', payload);
  }

  /**
   * Notifica que el trial terminó
   */
  static async notifyTrialEnded(
    userId: string
  ): Promise<SendNotificationResult> {
    const payload: NotificationPayload = {
      title: '📢 Tu prueba ha terminado',
      body: 'Tu período de prueba finalizó. Ahora tienes acceso limitado. ¡Suscríbete para recuperar todas las funciones premium!',
      data: {
        type: 'TRIAL_ENDED',
        screen: 'Subscriptions'
      }
    };

    return this.sendToUser(userId, 'TRIAL_ENDED', payload);
  }

  /**
   * Obtiene las preferencias de notificación del usuario
   */
  static async getPreferences(userId: string) {
    return prisma.notificationPreferences.findUnique({
      where: { userId }
    });
  }

  /**
   * Actualiza las preferencias de notificación del usuario
   */
  static async updatePreferences(
    userId: string,
    preferences: {
      emailSyncEnabled?: boolean;
      budgetAlertsEnabled?: boolean;
      goalRemindersEnabled?: boolean;
      weeklyReportEnabled?: boolean;
      tipsEnabled?: boolean;
      budgetAlertThreshold?: number;
      quietHoursStart?: number | null;
      quietHoursEnd?: number | null;
      antExpenseAlertsEnabled?: boolean;
      antExpenseAlertThreshold?: number;
      trialNotificationsEnabled?: boolean;
      goalReminderFrequency?: number;
    }
  ) {
    return prisma.notificationPreferences.upsert({
      where: { userId },
      update: preferences,
      create: {
        userId,
        ...preferences
      }
    });
  }

  /**
   * Obtiene el historial de notificaciones del usuario
   */
  static async getNotificationHistory(userId: string, limit: number = 50) {
    return prisma.notificationLog.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit
    });
  }

  /**
   * Marca una notificación como leída
   */
  static async markAsRead(notificationId: string) {
    return prisma.notificationLog.update({
      where: { id: notificationId },
      data: {
        status: 'READ',
        readAt: new Date()
      }
    });
  }

  /**
   * Elimina una notificación
   */
  static async deleteNotification(notificationId: string, userId: string): Promise<boolean> {
    try {
      // Verificar que la notificación pertenece al usuario
      const notification = await prisma.notificationLog.findFirst({
        where: {
          id: notificationId,
          userId
        }
      });

      if (!notification) {
        return false;
      }

      await prisma.notificationLog.delete({
        where: { id: notificationId }
      });

      return true;
    } catch (error) {
      logger.error('[NotificationService] Error deleting notification:', error);
      return false;
    }
  }

  /**
   * Elimina todas las notificaciones de un usuario
   */
  static async deleteAllNotifications(userId: string): Promise<number> {
    try {
      const result = await prisma.notificationLog.deleteMany({
        where: { userId }
      });
      return result.count;
    } catch (error) {
      logger.error('[NotificationService] Error deleting all notifications:', error);
      return 0;
    }
  }

  /**
   * Verifica y envía alertas de presupuesto después de crear una transacción
   * Compara el gasto antes y después para determinar si se debe enviar alerta
   * NOTA: Solo disponible para planes PLUS y PRO (budgetAlerts: true)
   */
  static async checkBudgetAlerts(
    userId: string,
    categoryId: string,
    transactionAmount: number,
    transactionDate: Date
  ): Promise<void> {
    try {
      // =============================================
      // VERIFICAR LÍMITE DE PLAN - BUDGET ALERTS
      // Solo PLUS y PRO tienen acceso a alertas de umbral
      // =============================================
      const subscription = await subscriptionService.getUserSubscription(userId);
      const planLimits = subscription.limits as { budgetAlerts?: boolean };
      const hasBudgetAlerts = planLimits.budgetAlerts ?? PLANS.FREE.limits.budgetAlerts;

      if (!hasBudgetAlerts) {
        // Usuario FREE - no enviar alertas de presupuesto
        return;
      }

      // Buscar presupuestos activos de la categoría que incluyan la fecha
      const budgets = await prisma.budget.findMany({
        where: {
          user_id: userId,
          category_id: categoryId,
          is_active: true,
          start_date: { lte: transactionDate },
          end_date: { gte: transactionDate }
        },
        include: {
          user: {
            select: { currency: true }
          }
        }
      });

      for (const budget of budgets) {
        const budgetAmount = Number(budget.amount);
        const currentSpent = Number(budget.spent) || 0;
        const alertThreshold = Number(budget.alert_percentage) || 80;
        const currency = budget.user?.currency || 'RD$';

        // El gasto antes de la transacción
        const previousSpent = currentSpent - transactionAmount;
        const previousPercentage = (previousSpent / budgetAmount) * 100;
        const currentPercentage = (currentSpent / budgetAmount) * 100;

        // Si cruzamos el umbral de alerta
        if (previousPercentage < alertThreshold && currentPercentage >= alertThreshold && currentPercentage < 100) {
          await this.notifyBudgetAlert(
            userId,
            budget.name,
            Math.round(currentPercentage),
            budgetAmount - currentSpent,
            currency
          );
          logger.log(`[NotificationService] Sent budget alert for ${budget.name}`);
        }

        // Si el presupuesto fue excedido
        if (previousPercentage < 100 && currentPercentage >= 100) {
          await this.notifyBudgetExceeded(
            userId,
            budget.name,
            currentSpent - budgetAmount,
            currency
          );
          logger.log(`[NotificationService] Sent budget exceeded alert for ${budget.name}`);
        }
      }
    } catch (error) {
      logger.error('[NotificationService] Error checking budget alerts:', error);
    }
  }
}

export default NotificationService;
