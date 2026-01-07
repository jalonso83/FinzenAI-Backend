import * as cron from 'node-cron';
import { prisma } from '../lib/prisma';
import { NotificationService } from './notificationService';
import { antExpenseService } from './antExpenseService';
import { subscriptionService } from './subscriptionService';
import { PLANS } from '../config/stripe';

import { logger } from '../utils/logger';
export class AntExpenseScheduler {
  private static isRunning: boolean = false;
  private static cronTask: cron.ScheduledTask | null = null;

  /**
   * Inicia el scheduler de alertas de gastos hormiga
   * Se ejecuta todos los lunes a las 10 AM UTC para analizar gastos de la semana
   */
  static startScheduler(): void {
    if (this.isRunning) {
      logger.log('[AntExpenseScheduler] Scheduler ya está ejecutándose');
      return;
    }

    logger.log('[AntExpenseScheduler] 🐜 Iniciando scheduler de alertas de gastos hormiga...');
    logger.log('[AntExpenseScheduler] 📅 Se ejecutará todos los lunes a las 10:00 AM UTC');

    // Ejecutar todos los lunes a las 10 AM UTC
    // Formato cron: minuto hora día-del-mes mes día-de-la-semana
    // 0 10 * * 1 = A las 10:00 AM, cualquier día del mes, cualquier mes, solo los lunes (1)
    this.cronTask = cron.schedule('0 10 * * 1', async () => {
      logger.log('[AntExpenseScheduler] 🔄 Ejecutando análisis de gastos hormiga...');

      try {
        await this.analyzeAllEligibleUsers();
      } catch (error) {
        logger.error('[AntExpenseScheduler] ❌ Error en ejecución del scheduler:', error);
      }
    });

    this.isRunning = true;
    logger.log('[AntExpenseScheduler] ✅ Scheduler iniciado correctamente');

    // Opcional: Ejecutar una vez al inicio para testing/desarrollo
    if (process.env.NODE_ENV === 'development') {
      logger.log('[AntExpenseScheduler] 🧪 Ejecutando análisis inicial (desarrollo)...');
      setTimeout(async () => {
        try {
          await this.analyzeAllEligibleUsers();
        } catch (error) {
          logger.error('[AntExpenseScheduler] ❌ Error en análisis inicial:', error);
        }
      }, 10000); // Esperar 10 segundos después del inicio
    }
  }

  /**
   * Detiene el scheduler (útil para testing o shutdown)
   */
  static stopScheduler(): void {
    if (!this.isRunning || !this.cronTask) {
      logger.log('[AntExpenseScheduler] Scheduler no está ejecutándose');
      return;
    }

    this.cronTask.stop();
    this.cronTask = null;
    this.isRunning = false;
    logger.log('[AntExpenseScheduler] ⏹️ Scheduler detenido');
  }

  /**
   * Analiza gastos hormiga para todos los usuarios elegibles
   * Solo usuarios PLUS/PRO con alertas habilitadas
   */
  static async analyzeAllEligibleUsers(): Promise<void> {
    logger.log('[AntExpenseScheduler] 🔍 Buscando usuarios elegibles para alertas...');

    try {
      // Obtener todos los usuarios con dispositivos activos y alertas habilitadas
      const eligibleUsers = await prisma.user.findMany({
        where: {
          // Tiene al menos un dispositivo activo
          devices: {
            some: {
              isActive: true
            }
          },
          // Tiene preferencias de notificación con alertas de gastos hormiga habilitadas
          notificationPreferences: {
            antExpenseAlertsEnabled: true
          }
        },
        include: {
          notificationPreferences: true
        }
      });

      logger.log(`[AntExpenseScheduler] 👥 ${eligibleUsers.length} usuarios elegibles encontrados`);

      let notificationsSent = 0;
      let usersSkipped = 0;
      let usersFree = 0;

      for (const user of eligibleUsers) {
        try {
          // Verificar que el usuario tenga plan PLUS o PRO
          const subscription = await subscriptionService.getUserSubscription(user.id);
          const planLimits = subscription.limits as { antExpenseAnalysis?: string };
          const hasFullAnalysis = planLimits.antExpenseAnalysis === 'full';

          if (!hasFullAnalysis) {
            // Usuario FREE - no enviar alertas proactivas
            usersFree++;
            continue;
          }

          // Obtener el umbral personalizado del usuario (default 20%)
          const alertThreshold = user.notificationPreferences?.antExpenseAlertThreshold ?? 20;

          // Analizar gastos hormiga del usuario
          const result = await antExpenseService.calculateAntExpenseStats(user.id);

          if (!result.canAnalyze || !result.calculations) {
            usersSkipped++;
            continue;
          }

          const { calculations } = result;

          // Solo notificar si el porcentaje supera el umbral del usuario
          if (calculations.percentageOfTotal >= alertThreshold) {
            const topCategory = calculations.topCriminals[0]?.category || 'Varios';

            await NotificationService.notifyAntExpenseAlert(
              user.id,
              calculations.totalAntExpenses,
              calculations.percentageOfTotal,
              topCategory,
              calculations.savingsOpportunityPerMonth,
              user.currency || 'RD$'
            );

            notificationsSent++;
            logger.log(`[AntExpenseScheduler] 📨 Alerta enviada a ${user.email} (${calculations.percentageOfTotal}% > ${alertThreshold}%)`);
          } else {
            usersSkipped++;
          }

        } catch (userError) {
          logger.error(`[AntExpenseScheduler] Error procesando usuario ${user.id}:`, userError);
        }
      }

      logger.log(`[AntExpenseScheduler] ✅ Análisis completado:`);
      logger.log(`   - Notificaciones enviadas: ${notificationsSent}`);
      logger.log(`   - Usuarios sin alertas (bajo umbral o sin datos): ${usersSkipped}`);
      logger.log(`   - Usuarios FREE (sin acceso): ${usersFree}`);

    } catch (error) {
      logger.error('[AntExpenseScheduler] ❌ Error analizando usuarios:', error);
      throw error;
    }
  }

  /**
   * Ejecuta manualmente el análisis (útil para testing)
   */
  static async runManual(): Promise<void> {
    logger.log('[AntExpenseScheduler] 🔧 Ejecutando análisis manual...');

    try {
      await this.analyzeAllEligibleUsers();
      logger.log('[AntExpenseScheduler] ✅ Análisis manual completado');
    } catch (error) {
      logger.error('[AntExpenseScheduler] ❌ Error en análisis manual:', error);
      throw error;
    }
  }

  /**
   * Analiza gastos hormiga para un usuario específico (útil para testing)
   */
  static async analyzeUser(userId: string): Promise<{
    sent: boolean;
    reason: string;
    data?: any;
  }> {
    logger.log(`[AntExpenseScheduler] 🔍 Analizando usuario ${userId}...`);

    try {
      // Verificar plan
      const subscription = await subscriptionService.getUserSubscription(userId);
      const planLimits = subscription.limits as { antExpenseAnalysis?: string };

      if (planLimits.antExpenseAnalysis !== 'full') {
        return {
          sent: false,
          reason: 'Usuario con plan FREE - alertas proactivas no disponibles'
        };
      }

      // Obtener preferencias
      const preferences = await prisma.notificationPreferences.findUnique({
        where: { userId }
      });

      if (!preferences?.antExpenseAlertsEnabled) {
        return {
          sent: false,
          reason: 'Alertas de gastos hormiga deshabilitadas por el usuario'
        };
      }

      // Analizar
      const result = await antExpenseService.calculateAntExpenseStats(userId);

      if (!result.canAnalyze || !result.calculations) {
        return {
          sent: false,
          reason: result.cannotAnalyzeReason || 'No hay suficientes datos para analizar'
        };
      }

      const { calculations } = result;
      const alertThreshold = preferences.antExpenseAlertThreshold ?? 20;

      if (calculations.percentageOfTotal < alertThreshold) {
        return {
          sent: false,
          reason: `Porcentaje (${calculations.percentageOfTotal}%) está por debajo del umbral (${alertThreshold}%)`,
          data: {
            percentage: calculations.percentageOfTotal,
            threshold: alertThreshold,
            totalAntExpenses: calculations.totalAntExpenses
          }
        };
      }

      // Obtener usuario para moneda
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { currency: true }
      });

      const topCategory = calculations.topCriminals[0]?.category || 'Varios';

      await NotificationService.notifyAntExpenseAlert(
        userId,
        calculations.totalAntExpenses,
        calculations.percentageOfTotal,
        topCategory,
        calculations.savingsOpportunityPerMonth,
        user?.currency || 'RD$'
      );

      return {
        sent: true,
        reason: 'Alerta enviada exitosamente',
        data: {
          percentage: calculations.percentageOfTotal,
          threshold: alertThreshold,
          totalAntExpenses: calculations.totalAntExpenses,
          topCategory,
          savingsOpportunity: calculations.savingsOpportunityPerMonth
        }
      };

    } catch (error: any) {
      logger.error(`[AntExpenseScheduler] Error analizando usuario ${userId}:`, error);
      return {
        sent: false,
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
      nextExecution: this.isRunning ? 'Todos los lunes a las 10:00 AM UTC' : 'Detenido'
    };
  }
}
