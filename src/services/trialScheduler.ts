import * as cron from 'node-cron';
import { NotificationType } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { NotificationService } from './notificationService';

import { logger } from '../utils/logger';
// Tipos de notificación de trial y sus días correspondientes
const TRIAL_NOTIFICATIONS: { day: number; type: NotificationType }[] = [
  { day: 1, type: 'TRIAL_WELCOME' },
  { day: 3, type: 'TRIAL_DAY_3' },
  { day: 5, type: 'TRIAL_DAY_5' },
  { day: 7, type: 'TRIAL_ENDING' },
];

export class TrialScheduler {
  private static isRunning: boolean = false;
  private static cronTask: cron.ScheduledTask | null = null;

  /**
   * Inicia el scheduler de notificaciones de trial
   * Se ejecuta todos los días a las 9 AM UTC para enviar notificaciones de trial
   */
  static startScheduler(): void {
    if (this.isRunning) {
      logger.log('[TrialScheduler] Scheduler ya está ejecutándose');
      return;
    }

    logger.log('[TrialScheduler] 🎯 Iniciando scheduler de notificaciones de trial...');
    logger.log('[TrialScheduler] 📅 Se ejecutará diariamente a las 9:00 AM UTC');

    // Ejecutar todos los días a las 9 AM UTC
    this.cronTask = cron.schedule('0 9 * * *', async () => {
      logger.log('[TrialScheduler] 🔄 Ejecutando verificación de trials...');

      try {
        await this.processTrialNotifications();
      } catch (error) {
        logger.error('[TrialScheduler] ❌ Error en ejecución del scheduler:', error);
      }
    });

    this.isRunning = true;
    logger.log('[TrialScheduler] ✅ Scheduler iniciado correctamente');

    // Opcional: Ejecutar una vez al inicio para testing/desarrollo
    if (process.env.NODE_ENV === 'development') {
      logger.log('[TrialScheduler] 🧪 Ejecutando verificación inicial (desarrollo)...');
      setTimeout(async () => {
        try {
          await this.processTrialNotifications();
        } catch (error) {
          logger.error('[TrialScheduler] ❌ Error en verificación inicial:', error);
        }
      }, 15000); // Esperar 15 segundos después del inicio
    }
  }

  /**
   * Detiene el scheduler
   */
  static stopScheduler(): void {
    if (!this.isRunning || !this.cronTask) {
      logger.log('[TrialScheduler] Scheduler no está ejecutándose');
      return;
    }

    this.cronTask.stop();
    this.cronTask = null;
    this.isRunning = false;
    logger.log('[TrialScheduler] ⏹️ Scheduler detenido');
  }

  /**
   * Procesa las notificaciones de trial para todos los usuarios
   */
  static async processTrialNotifications(): Promise<void> {
    logger.log('[TrialScheduler] 🔍 Buscando usuarios en período de prueba...');

    try {
      // Obtener todos los usuarios con trial activo
      const usersInTrial = await prisma.subscription.findMany({
        where: {
          status: 'TRIALING',
          trialStartedAt: { not: null },
          trialEndsAt: { not: null }
        },
        include: {
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              devices: {
                where: { isActive: true }
              },
              notificationPreferences: true
            }
          }
        }
      });

      logger.log(`[TrialScheduler] 👥 ${usersInTrial.length} usuarios en período de prueba`);

      let notificationsSent = 0;
      let trialsEnded = 0;
      let skipped = 0;

      const now = new Date();

      for (const subscription of usersInTrial) {
        try {
          const { user } = subscription;

          // Verificar que el usuario tiene dispositivos activos
          if (!user.devices || user.devices.length === 0) {
            skipped++;
            continue;
          }

          // Verificar preferencias de notificación
          if (user.notificationPreferences && !user.notificationPreferences.trialNotificationsEnabled) {
            skipped++;
            continue;
          }

          // Calcular día del trial
          const trialStartedAt = subscription.trialStartedAt!;
          const trialEndsAt = subscription.trialEndsAt!;
          const dayOfTrial = this.calculateDayOfTrial(trialStartedAt);
          const daysRemaining = this.calculateDaysRemaining(trialEndsAt);

          // Obtener notificaciones ya enviadas
          const sentNotifications = (subscription.trialNotificationsSent as string[]) || [];

          // Verificar si el trial terminó
          if (daysRemaining < 0) {
            // Trial terminó - enviar notificación de fin y actualizar estado
            if (!sentNotifications.includes('TRIAL_ENDED')) {
              await this.handleTrialEnded(subscription.id, user.id);
              trialsEnded++;
            }
            continue;
          }

          // Buscar la notificación correspondiente al día actual
          const notificationToSend = TRIAL_NOTIFICATIONS.find(n => n.day === dayOfTrial);

          if (notificationToSend && !sentNotifications.includes(notificationToSend.type)) {
            const sent = await this.sendTrialNotification(
              user.id,
              user.name,
              notificationToSend.type,
              subscription.id,
              sentNotifications
            );

            if (sent) {
              notificationsSent++;
              logger.log(`[TrialScheduler] 📨 ${notificationToSend.type} enviado a ${user.email} (día ${dayOfTrial})`);
            }
          }

        } catch (userError) {
          logger.error(`[TrialScheduler] Error procesando usuario:`, userError);
        }
      }

      logger.log(`[TrialScheduler] ✅ Proceso completado:`);
      logger.log(`   - Notificaciones enviadas: ${notificationsSent}`);
      logger.log(`   - Trials finalizados: ${trialsEnded}`);
      logger.log(`   - Usuarios omitidos: ${skipped}`);

    } catch (error) {
      logger.error('[TrialScheduler] ❌ Error procesando notificaciones de trial:', error);
      throw error;
    }
  }

  /**
   * Calcula el día del trial (1-7)
   */
  private static calculateDayOfTrial(trialStartedAt: Date): number {
    const now = new Date();
    const diffTime = now.getTime() - trialStartedAt.getTime();
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    return Math.max(1, Math.min(diffDays, 8)); // Entre 1 y 8
  }

  /**
   * Calcula días restantes del trial
   */
  private static calculateDaysRemaining(trialEndsAt: Date): number {
    const now = new Date();
    const diffTime = trialEndsAt.getTime() - now.getTime();
    return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  }

  /**
   * Envía una notificación de trial y actualiza el registro
   */
  private static async sendTrialNotification(
    userId: string,
    userName: string,
    notificationType: NotificationType,
    subscriptionId: string,
    sentNotifications: string[]
  ): Promise<boolean> {
    try {
      let result;

      switch (notificationType) {
        case 'TRIAL_WELCOME':
          result = await NotificationService.notifyTrialWelcome(userId, userName);
          break;
        case 'TRIAL_DAY_3':
          result = await NotificationService.notifyTrialDay3(userId);
          break;
        case 'TRIAL_DAY_5':
          result = await NotificationService.notifyTrialDay5(userId);
          break;
        case 'TRIAL_ENDING':
          result = await NotificationService.notifyTrialEnding(userId);
          break;
        default:
          return false;
      }

      if (result.success || result.successCount > 0) {
        // Actualizar registro de notificaciones enviadas
        const updatedNotifications = [...sentNotifications, notificationType];
        await prisma.subscription.update({
          where: { id: subscriptionId },
          data: {
            trialNotificationsSent: updatedNotifications
          }
        });
        return true;
      }

      return false;
    } catch (error) {
      logger.error(`[TrialScheduler] Error enviando ${notificationType}:`, error);
      return false;
    }
  }

  /**
   * Maneja el fin del período de trial
   */
  private static async handleTrialEnded(subscriptionId: string, userId: string): Promise<void> {
    try {
      // Enviar notificación de trial terminado
      await NotificationService.notifyTrialEnded(userId);

      // Obtener notificaciones previas
      const subscription = await prisma.subscription.findUnique({
        where: { id: subscriptionId }
      });
      const sentNotifications = (subscription?.trialNotificationsSent as string[]) || [];

      // Actualizar suscripción: cambiar estado a ACTIVE con plan FREE
      await prisma.subscription.update({
        where: { id: subscriptionId },
        data: {
          status: 'ACTIVE',
          plan: 'FREE',
          trialNotificationsSent: [...sentNotifications, 'TRIAL_ENDED']
        }
      });

      logger.log(`[TrialScheduler] 🔄 Trial terminado para usuario ${userId} - Cambiado a plan FREE`);
    } catch (error) {
      logger.error(`[TrialScheduler] Error manejando fin de trial:`, error);
    }
  }

  /**
   * Ejecuta manualmente el procesamiento (útil para testing)
   */
  static async runManual(): Promise<void> {
    logger.log('[TrialScheduler] 🔧 Ejecutando verificación manual...');

    try {
      await this.processTrialNotifications();
      logger.log('[TrialScheduler] ✅ Verificación manual completada');
    } catch (error) {
      logger.error('[TrialScheduler] ❌ Error en verificación manual:', error);
      throw error;
    }
  }

  /**
   * Verifica si un dispositivo ya usó un trial
   */
  static async hasDeviceUsedTrial(deviceId: string): Promise<boolean> {
    if (!deviceId) return false;

    const existingDevice = await prisma.trialDeviceRegistry.findUnique({
      where: { deviceId }
    });

    return !!existingDevice;
  }

  /**
   * Verifica si un email ya usó un trial
   */
  static async hasEmailUsedTrial(userId: string): Promise<boolean> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { hasUsedTrial: true }
    });

    return user?.hasUsedTrial ?? false;
  }

  /**
   * Verifica elegibilidad para trial
   * Retorna: { eligible: boolean, reason?: string }
   */
  static async checkTrialEligibility(
    userId: string,
    deviceId?: string
  ): Promise<{ eligible: boolean; reason?: string }> {
    // Verificar restricción por email
    const emailUsedTrial = await this.hasEmailUsedTrial(userId);
    if (emailUsedTrial) {
      return {
        eligible: false,
        reason: 'EMAIL_ALREADY_USED_TRIAL'
      };
    }

    // Verificar restricción por dispositivo
    if (deviceId) {
      const deviceUsedTrial = await this.hasDeviceUsedTrial(deviceId);
      if (deviceUsedTrial) {
        return {
          eligible: false,
          reason: 'DEVICE_ALREADY_USED_TRIAL'
        };
      }
    }

    return { eligible: true };
  }

  /**
   * Registra un dispositivo como usado para trial
   */
  private static async registerDeviceForTrial(
    deviceId: string,
    userId: string,
    email: string,
    platform?: string,
    deviceName?: string
  ): Promise<void> {
    try {
      await prisma.trialDeviceRegistry.create({
        data: {
          deviceId,
          usedByUserId: userId,
          usedByEmail: email,
          platform,
          deviceName
        }
      });
      logger.log(`[TrialScheduler] 📱 Dispositivo registrado para trial: ${deviceId}`);
    } catch (error) {
      // Si ya existe, ignorar (puede pasar en race conditions)
      logger.warn(`[TrialScheduler] Dispositivo ya registrado o error:`, error);
    }
  }

  /**
   * Inicia un trial para un usuario específico
   * Llamar al registrar un usuario nuevo
   *
   * @param userId - ID del usuario
   * @param deviceInfo - Información opcional del dispositivo para restricción anti-abuso
   */
  static async startTrialForUser(
    userId: string,
    deviceInfo?: {
      deviceId?: string;
      platform?: string;
      deviceName?: string;
    }
  ): Promise<{ success: boolean; trialStarted: boolean; reason?: string }> {
    try {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true, hasUsedTrial: true }
      });

      if (!user) {
        return { success: false, trialStarted: false, reason: 'USER_NOT_FOUND' };
      }

      // Verificar elegibilidad para trial
      const eligibility = await this.checkTrialEligibility(userId, deviceInfo?.deviceId);

      if (!eligibility.eligible) {
        logger.log(`[TrialScheduler] ⚠️ Usuario ${userId} no elegible para trial: ${eligibility.reason}`);

        // Crear suscripción FREE (sin trial)
        await prisma.subscription.upsert({
          where: { userId },
          update: {
            status: 'ACTIVE',
            plan: 'FREE'
          },
          create: {
            userId,
            status: 'ACTIVE',
            plan: 'FREE'
          }
        });

        return {
          success: true,
          trialStarted: false,
          reason: eligibility.reason
        };
      }

      // Usuario elegible - iniciar trial
      const now = new Date();
      const trialEndsAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // +7 días

      // Crear suscripción con trial
      await prisma.subscription.upsert({
        where: { userId },
        update: {
          status: 'TRIALING',
          plan: 'PREMIUM', // Durante el trial tienen acceso PREMIUM
          trialStartedAt: now,
          trialEndsAt: trialEndsAt,
          trialNotificationsSent: []
        },
        create: {
          userId,
          status: 'TRIALING',
          plan: 'PREMIUM', // Durante el trial tienen acceso PREMIUM
          trialStartedAt: now,
          trialEndsAt: trialEndsAt,
          trialNotificationsSent: []
        }
      });

      // Marcar email como usado para trial
      await prisma.user.update({
        where: { id: userId },
        data: { hasUsedTrial: true }
      });

      // Registrar dispositivo si se proporcionó
      if (deviceInfo?.deviceId) {
        await this.registerDeviceForTrial(
          deviceInfo.deviceId,
          userId,
          user.email,
          deviceInfo.platform,
          deviceInfo.deviceName
        );
      }

      logger.log(`[TrialScheduler] 🎯 Trial iniciado para usuario ${userId} - Termina: ${trialEndsAt.toISOString()}`);

      // Enviar notificación de bienvenida inmediatamente
      setTimeout(async () => {
        try {
          await NotificationService.notifyTrialWelcome(userId, user.name);

          // Marcar la notificación como enviada
          await prisma.subscription.update({
            where: { userId },
            data: {
              trialNotificationsSent: ['TRIAL_WELCOME']
            }
          });
          logger.log(`[TrialScheduler] 📨 Notificación de bienvenida enviada a ${userId}`);
        } catch (error) {
          logger.error(`[TrialScheduler] Error enviando bienvenida:`, error);
        }
      }, 5000); // Esperar 5 segundos

      return { success: true, trialStarted: true };

    } catch (error) {
      logger.error(`[TrialScheduler] Error iniciando trial para ${userId}:`, error);
      throw error;
    }
  }

  /**
   * Obtiene el estado del scheduler
   */
  static getStatus(): { isRunning: boolean; nextExecution: string } {
    return {
      isRunning: this.isRunning,
      nextExecution: this.isRunning ? 'Diariamente a las 9:00 AM UTC' : 'Detenido'
    };
  }
}
