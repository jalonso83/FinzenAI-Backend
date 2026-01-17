import * as cron from 'node-cron';
import { prisma } from '../lib/prisma';
import { NotificationService } from './notificationService';

import { logger } from '../utils/logger';

export class GoalReminderScheduler {
  private static isRunning: boolean = false;
  private static cronTask: cron.ScheduledTask | null = null;

  /**
   * Inicia el scheduler de recordatorios de metas
   * Se ejecuta todos los días a las 9 AM UTC
   */
  static startScheduler(): void {
    if (this.isRunning) {
      logger.log('[GoalReminderScheduler] Scheduler ya está ejecutándose');
      return;
    }

    logger.log('[GoalReminderScheduler] 🎯 Iniciando scheduler de recordatorios de metas...');
    logger.log('[GoalReminderScheduler] 📅 Se ejecutará todos los días a las 9:00 AM UTC');

    // Ejecutar todos los días a las 9 AM UTC
    // Formato cron: minuto hora día-del-mes mes día-de-la-semana
    // 0 9 * * * = A las 9:00 AM, todos los días
    this.cronTask = cron.schedule('0 9 * * *', async () => {
      logger.log('[GoalReminderScheduler] 🔄 Ejecutando verificación de recordatorios de metas...');

      try {
        await this.checkAllUsersGoals();
      } catch (error) {
        logger.error('[GoalReminderScheduler] ❌ Error en ejecución del scheduler:', error);
      }
    });

    this.isRunning = true;
    logger.log('[GoalReminderScheduler] ✅ Scheduler iniciado correctamente');

    // Opcional: Ejecutar una vez al inicio para testing/desarrollo
    if (process.env.NODE_ENV === 'development') {
      logger.log('[GoalReminderScheduler] 🧪 Ejecutando verificación inicial (desarrollo)...');
      setTimeout(async () => {
        try {
          await this.checkAllUsersGoals();
        } catch (error) {
          logger.error('[GoalReminderScheduler] ❌ Error en verificación inicial:', error);
        }
      }, 15000); // Esperar 15 segundos después del inicio
    }
  }

  /**
   * Detiene el scheduler
   */
  static stopScheduler(): void {
    if (!this.isRunning || !this.cronTask) {
      logger.log('[GoalReminderScheduler] Scheduler no está ejecutándose');
      return;
    }

    this.cronTask.stop();
    this.cronTask = null;
    this.isRunning = false;
    logger.log('[GoalReminderScheduler] ⏹️ Scheduler detenido');
  }

  /**
   * Verifica las metas de todos los usuarios elegibles
   */
  static async checkAllUsersGoals(): Promise<void> {
    logger.log('[GoalReminderScheduler] 🔍 Buscando usuarios con recordatorios habilitados...');

    try {
      // Obtener usuarios con:
      // - Al menos un dispositivo activo
      // - Recordatorios de metas habilitados
      // - Frecuencia de recordatorio > 0 (0 = nunca)
      const eligibleUsers = await prisma.user.findMany({
        where: {
          devices: {
            some: {
              isActive: true
            }
          },
          notificationPreferences: {
            goalRemindersEnabled: true,
            goalReminderFrequency: {
              gt: 0
            }
          }
        },
        include: {
          notificationPreferences: true
        }
      });

      logger.log(`[GoalReminderScheduler] 👥 ${eligibleUsers.length} usuarios elegibles encontrados`);

      let notificationsSent = 0;
      let goalsChecked = 0;

      for (const user of eligibleUsers) {
        try {
          const result = await this.checkUserGoals(user.id, user.notificationPreferences!);
          notificationsSent += result.notificationsSent;
          goalsChecked += result.goalsChecked;
        } catch (userError) {
          logger.error(`[GoalReminderScheduler] Error procesando usuario ${user.id}:`, userError);
        }
      }

      logger.log(`[GoalReminderScheduler] ✅ Verificación completada:`);
      logger.log(`   - Metas verificadas: ${goalsChecked}`);
      logger.log(`   - Notificaciones enviadas: ${notificationsSent}`);

    } catch (error) {
      logger.error('[GoalReminderScheduler] ❌ Error verificando usuarios:', error);
      throw error;
    }
  }

  /**
   * Verifica las metas de un usuario específico
   */
  private static async checkUserGoals(
    userId: string,
    preferences: { goalReminderFrequency: number }
  ): Promise<{ goalsChecked: number; notificationsSent: number }> {
    const frequencyDays = preferences.goalReminderFrequency;
    const now = new Date();
    const cutoffDate = new Date(now.getTime() - (frequencyDays * 24 * 60 * 60 * 1000));

    // Obtener metas activas no completadas del usuario
    const goals = await prisma.goal.findMany({
      where: {
        userId,
        isActive: true,
        isCompleted: false,
        // lastContributionDate es null O es anterior a la fecha de corte
        OR: [
          { lastContributionDate: null },
          { lastContributionDate: { lt: cutoffDate } }
        ]
      },
      include: {
        user: {
          select: { currency: true }
        }
      }
    });

    let notificationsSent = 0;

    for (const goal of goals) {
      const currentAmount = Number(goal.currentAmount);
      const targetAmount = Number(goal.targetAmount);
      const percentageComplete = Math.round((currentAmount / targetAmount) * 100);
      const amountRemaining = targetAmount - currentAmount;
      const currency = goal.user?.currency || 'RD$';

      // Calcular días sin contribuir
      let daysSinceLastContribution: number;
      if (goal.lastContributionDate) {
        daysSinceLastContribution = Math.floor(
          (now.getTime() - goal.lastContributionDate.getTime()) / (24 * 60 * 60 * 1000)
        );
      } else {
        // Si nunca ha contribuido, usar días desde la creación
        daysSinceLastContribution = Math.floor(
          (now.getTime() - goal.createdAt.getTime()) / (24 * 60 * 60 * 1000)
        );
      }

      // Solo notificar si realmente han pasado los días configurados
      if (daysSinceLastContribution >= frequencyDays) {
        await NotificationService.notifyGoalReminder(
          userId,
          goal.name,
          percentageComplete,
          amountRemaining,
          currency
        );

        notificationsSent++;
        logger.log(`[GoalReminderScheduler] 📨 Recordatorio enviado para meta "${goal.name}" (${daysSinceLastContribution} días sin contribuir)`);
      }
    }

    return {
      goalsChecked: goals.length,
      notificationsSent
    };
  }

  /**
   * Ejecuta manualmente la verificación (útil para testing)
   */
  static async runManual(): Promise<void> {
    logger.log('[GoalReminderScheduler] 🔧 Ejecutando verificación manual...');

    try {
      await this.checkAllUsersGoals();
      logger.log('[GoalReminderScheduler] ✅ Verificación manual completada');
    } catch (error) {
      logger.error('[GoalReminderScheduler] ❌ Error en verificación manual:', error);
      throw error;
    }
  }

  /**
   * Verifica metas de un usuario específico (útil para testing)
   */
  static async checkSingleUser(userId: string): Promise<{
    sent: boolean;
    goalsChecked: number;
    notificationsSent: number;
    reason: string;
  }> {
    logger.log(`[GoalReminderScheduler] 🔍 Verificando usuario ${userId}...`);

    try {
      // Obtener preferencias
      const preferences = await prisma.notificationPreferences.findUnique({
        where: { userId }
      });

      if (!preferences?.goalRemindersEnabled) {
        return {
          sent: false,
          goalsChecked: 0,
          notificationsSent: 0,
          reason: 'Recordatorios de metas deshabilitados por el usuario'
        };
      }

      if (!preferences.goalReminderFrequency || preferences.goalReminderFrequency === 0) {
        return {
          sent: false,
          goalsChecked: 0,
          notificationsSent: 0,
          reason: 'Frecuencia de recordatorio configurada en "Nunca"'
        };
      }

      const result = await this.checkUserGoals(userId, {
        goalReminderFrequency: preferences.goalReminderFrequency
      });

      return {
        sent: result.notificationsSent > 0,
        goalsChecked: result.goalsChecked,
        notificationsSent: result.notificationsSent,
        reason: result.notificationsSent > 0
          ? `Se enviaron ${result.notificationsSent} recordatorios`
          : result.goalsChecked > 0
            ? 'Metas encontradas pero con contribuciones recientes'
            : 'No hay metas activas sin completar'
      };

    } catch (error: any) {
      logger.error(`[GoalReminderScheduler] Error verificando usuario ${userId}:`, error);
      return {
        sent: false,
        goalsChecked: 0,
        notificationsSent: 0,
        reason: `Error: ${error.message}`
      };
    }
  }

  /**
   * Obtiene el estado del scheduler
   */
  static getStatus(): { isRunning: boolean; nextExecution: string } {
    return {
      isRunning: this.isRunning,
      nextExecution: this.isRunning ? 'Todos los días a las 9:00 AM UTC' : 'Detenido'
    };
  }
}
