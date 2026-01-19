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

  private static weeklyCronTask: cron.ScheduledTask | null = null;
  private static monthlyCronTask: cron.ScheduledTask | null = null;

  /**
   * Inicia el scheduler de alertas de gastos hormiga
   * - Semanal: Lunes 10 AM UTC (últimos 7 días)
   * - Mensual: Día 1 a las 10 AM UTC (últimos 30 días)
   */
  static startScheduler(): void {
    if (this.isRunning) {
      logger.log('[AntExpenseScheduler] Scheduler ya está ejecutándose');
      return;
    }

    logger.log('[AntExpenseScheduler] 🐜 Iniciando scheduler de alertas de gastos hormiga...');
    logger.log('[AntExpenseScheduler] 📅 Semanal: Lunes 10:00 AM UTC');
    logger.log('[AntExpenseScheduler] 📅 Mensual: Día 1 a las 10:00 AM UTC');

    // SEMANAL: Todos los lunes a las 10 AM UTC (últimos 7 días)
    this.weeklyCronTask = cron.schedule('0 10 * * 1', async () => {
      logger.log('[AntExpenseScheduler] 🔄 Ejecutando análisis SEMANAL de gastos hormiga...');
      try {
        await this.analyzeAllEligibleUsers('weekly');
      } catch (error) {
        logger.error('[AntExpenseScheduler] ❌ Error en análisis semanal:', error);
      }
    });

    // MENSUAL: Día 1 de cada mes a las 10 AM UTC (últimos 30 días)
    this.monthlyCronTask = cron.schedule('0 10 1 * *', async () => {
      logger.log('[AntExpenseScheduler] 🔄 Ejecutando análisis MENSUAL de gastos hormiga...');
      try {
        await this.analyzeAllEligibleUsers('monthly');
      } catch (error) {
        logger.error('[AntExpenseScheduler] ❌ Error en análisis mensual:', error);
      }
    });

    this.isRunning = true;
    this.cronTask = this.weeklyCronTask; // Mantener compatibilidad
    logger.log('[AntExpenseScheduler] ✅ Scheduler iniciado correctamente');

    // Opcional: Ejecutar una vez al inicio para testing/desarrollo
    if (process.env.NODE_ENV === 'development') {
      logger.log('[AntExpenseScheduler] 🧪 Ejecutando análisis inicial (desarrollo)...');
      setTimeout(async () => {
        try {
          await this.analyzeAllEligibleUsers('weekly');
        } catch (error) {
          logger.error('[AntExpenseScheduler] ❌ Error en análisis inicial:', error);
        }
      }, 10000);
    }
  }

  /**
   * Detiene el scheduler (útil para testing o shutdown)
   */
  static stopScheduler(): void {
    if (!this.isRunning) {
      logger.log('[AntExpenseScheduler] Scheduler no está ejecutándose');
      return;
    }

    if (this.weeklyCronTask) {
      this.weeklyCronTask.stop();
      this.weeklyCronTask = null;
    }
    if (this.monthlyCronTask) {
      this.monthlyCronTask.stop();
      this.monthlyCronTask = null;
    }
    this.cronTask = null;
    this.isRunning = false;
    logger.log('[AntExpenseScheduler] ⏹️ Scheduler detenido');
  }

  /**
   * Analiza gastos hormiga para todos los usuarios elegibles
   * Solo usuarios PRO con alertas habilitadas
   * @param period 'weekly' (7 días) o 'monthly' (30 días)
   */
  static async analyzeAllEligibleUsers(period: 'weekly' | 'monthly' = 'weekly'): Promise<void> {
    const daysToAnalyze = period === 'weekly' ? 7 : 30;
    const periodLabel = period === 'weekly' ? 'SEMANAL' : 'MENSUAL';

    logger.log(`[AntExpenseScheduler] 🔍 Análisis ${periodLabel}: Buscando usuarios PRO elegibles...`);

    try {
      // Obtener todos los usuarios con dispositivos activos y alertas habilitadas
      const eligibleUsers = await prisma.user.findMany({
        where: {
          devices: {
            some: {
              isActive: true
            }
          },
          notificationPreferences: {
            antExpenseAlertsEnabled: true
          }
        },
        include: {
          notificationPreferences: true
        }
      });

      logger.log(`[AntExpenseScheduler] 👥 ${eligibleUsers.length} usuarios con alertas habilitadas`);

      let notificationsSent = 0;
      let usersSkipped = 0;
      let usersNotPro = 0;

      for (const user of eligibleUsers) {
        try {
          // Verificar que el usuario tenga plan PRO (único con alertas automáticas)
          const subscription = await subscriptionService.getUserSubscription(user.id);
          const planLimits = subscription.limits as { antExpenseAlerts?: boolean };

          if (!planLimits.antExpenseAlerts) {
            // Usuario FREE o PLUS - no enviar alertas proactivas
            usersNotPro++;
            continue;
          }

          // Obtener configuración personalizada del usuario
          const userAmountThreshold = user.notificationPreferences?.antExpenseAmountThreshold ?? 500;
          const userMinFrequency = user.notificationPreferences?.antExpenseMinFrequency ?? 3;
          const alertPercentageThreshold = user.notificationPreferences?.antExpenseAlertThreshold ?? 20;

          // Analizar gastos hormiga con la configuración del usuario
          const result = await antExpenseService.calculateAntExpenseStats(user.id, {
            antThreshold: userAmountThreshold,
            minFrequency: userMinFrequency,
            monthsToAnalyze: period === 'weekly' ? 1 : 1, // Usamos días, no meses
          }, daysToAnalyze);

          if (!result.canAnalyze || !result.calculations) {
            usersSkipped++;
            continue;
          }

          const { calculations } = result;

          // Solo notificar si el porcentaje supera el umbral del usuario
          if (calculations.percentageOfTotal >= alertPercentageThreshold) {
            const topCategory = calculations.topCriminals[0]?.category || 'Varios';

            await NotificationService.notifyAntExpenseAlert(
              user.id,
              calculations.totalAntExpenses,
              calculations.percentageOfTotal,
              topCategory,
              calculations.savingsOpportunityPerMonth,
              user.currency || 'RD$',
              period // Pasar el período para personalizar el mensaje
            );

            notificationsSent++;
            logger.log(`[AntExpenseScheduler] 📨 Alerta ${periodLabel} enviada a ${user.email} (${calculations.percentageOfTotal.toFixed(1)}% > ${alertPercentageThreshold}%)`);
          } else {
            usersSkipped++;
          }

        } catch (userError) {
          logger.error(`[AntExpenseScheduler] Error procesando usuario ${user.id}:`, userError);
        }
      }

      logger.log(`[AntExpenseScheduler] ✅ Análisis ${periodLabel} completado:`);
      logger.log(`   - Notificaciones enviadas: ${notificationsSent}`);
      logger.log(`   - Usuarios sin alertas (bajo umbral o sin datos): ${usersSkipped}`);
      logger.log(`   - Usuarios sin plan PRO: ${usersNotPro}`);

    } catch (error) {
      logger.error(`[AntExpenseScheduler] ❌ Error en análisis ${periodLabel}:`, error);
      throw error;
    }
  }

  /**
   * Ejecuta manualmente el análisis (útil para testing)
   * @param period 'weekly' o 'monthly'
   */
  static async runManual(period: 'weekly' | 'monthly' = 'weekly'): Promise<void> {
    logger.log(`[AntExpenseScheduler] 🔧 Ejecutando análisis manual (${period})...`);

    try {
      await this.analyzeAllEligibleUsers(period);
      logger.log('[AntExpenseScheduler] ✅ Análisis manual completado');
    } catch (error) {
      logger.error('[AntExpenseScheduler] ❌ Error en análisis manual:', error);
      throw error;
    }
  }

  /**
   * Analiza gastos hormiga para un usuario específico (útil para testing)
   * @param period 'weekly' (7 días) o 'monthly' (30 días)
   */
  static async analyzeUser(userId: string, period: 'weekly' | 'monthly' = 'weekly'): Promise<{
    sent: boolean;
    reason: string;
    data?: any;
  }> {
    const daysToAnalyze = period === 'weekly' ? 7 : 30;
    logger.log(`[AntExpenseScheduler] 🔍 Analizando usuario ${userId} (${period}, ${daysToAnalyze} días)...`);

    try {
      // Verificar plan - Solo PRO tiene alertas automáticas
      const subscription = await subscriptionService.getUserSubscription(userId);
      const planLimits = subscription.limits as { antExpenseAlerts?: boolean };

      if (!planLimits.antExpenseAlerts) {
        return {
          sent: false,
          reason: 'Usuario sin plan PRO - alertas automáticas no disponibles'
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

      // Obtener configuración personalizada del usuario
      const userAmountThreshold = preferences.antExpenseAmountThreshold ?? 500;
      const userMinFrequency = preferences.antExpenseMinFrequency ?? 3;
      const alertPercentageThreshold = preferences.antExpenseAlertThreshold ?? 20;

      // Analizar con configuración del usuario
      const result = await antExpenseService.calculateAntExpenseStats(userId, {
        antThreshold: userAmountThreshold,
        minFrequency: userMinFrequency,
        monthsToAnalyze: 1,
      }, daysToAnalyze);

      if (!result.canAnalyze || !result.calculations) {
        return {
          sent: false,
          reason: result.cannotAnalyzeReason || 'No hay suficientes datos para analizar'
        };
      }

      const { calculations } = result;

      if (calculations.percentageOfTotal < alertPercentageThreshold) {
        return {
          sent: false,
          reason: `Porcentaje (${calculations.percentageOfTotal.toFixed(1)}%) está por debajo del umbral (${alertPercentageThreshold}%)`,
          data: {
            percentage: calculations.percentageOfTotal,
            threshold: alertPercentageThreshold,
            totalAntExpenses: calculations.totalAntExpenses,
            config: { userAmountThreshold, userMinFrequency }
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
        user?.currency || 'RD$',
        period
      );

      return {
        sent: true,
        reason: `Alerta ${period} enviada exitosamente`,
        data: {
          period,
          daysAnalyzed: daysToAnalyze,
          percentage: calculations.percentageOfTotal,
          threshold: alertPercentageThreshold,
          totalAntExpenses: calculations.totalAntExpenses,
          topCategory,
          savingsOpportunity: calculations.savingsOpportunityPerMonth,
          config: { userAmountThreshold, userMinFrequency }
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
  static getStatus(): { isRunning: boolean; schedules: { weekly: string; monthly: string } } {
    return {
      isRunning: this.isRunning,
      schedules: {
        weekly: this.isRunning ? 'Lunes 10:00 AM UTC (últimos 7 días)' : 'Detenido',
        monthly: this.isRunning ? 'Día 1 a las 10:00 AM UTC (últimos 30 días)' : 'Detenido'
      }
    };
  }
}
