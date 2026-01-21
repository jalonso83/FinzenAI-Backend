import * as cron from 'node-cron';
import { prisma } from '../lib/prisma';
import { NotificationService } from './notificationService';
import { antExpenseService } from './antExpenseService';
import { subscriptionService } from './subscriptionService';
import { PLANS } from '../config/stripe';
import { logger } from '../utils/logger';
import { isTargetLocalTime, isInQuietHours, getTimezoneByCountry } from '../utils/timezone';

/**
 * Scheduler para alertas de gastos hormiga
 *
 * TIMEZONE-AWARE: Los usuarios reciben alertas a las 10:00 AM
 * de su hora local, los lunes (semanal) y día 1 (mensual).
 *
 * Ejecuta cada hora para capturar usuarios en diferentes zonas horarias.
 */
export class AntExpenseScheduler {
  private static isRunning: boolean = false;
  private static cronTask: cron.ScheduledTask | null = null;

  private static weeklyCronTask: cron.ScheduledTask | null = null;
  private static monthlyCronTask: cron.ScheduledTask | null = null;

  // Hora objetivo para enviar alertas (10:00 AM hora local del usuario)
  private static readonly TARGET_HOUR = 10;
  private static readonly TARGET_MINUTE = 0;

  /**
   * Inicia el scheduler de alertas de gastos hormiga
   * TIMEZONE-AWARE:
   * - Semanal: Lunes 10 AM hora local del usuario (últimos 7 días)
   * - Mensual: Día 1 a las 10 AM hora local del usuario (últimos 30 días)
   *
   * Ambos jobs se ejecutan cada hora para capturar usuarios en diferentes zonas horarias.
   */
  static startScheduler(): void {
    if (this.isRunning) {
      logger.log('[AntExpenseScheduler] Scheduler ya está ejecutándose');
      return;
    }

    logger.log('[AntExpenseScheduler] 🐜 Iniciando scheduler de alertas de gastos hormiga...');
    logger.log('[AntExpenseScheduler] 📅 Semanal: Cada hora - Lunes 10:00 AM hora local del usuario');
    logger.log('[AntExpenseScheduler] 📅 Mensual: Cada hora - Día 1 a las 10:00 AM hora local del usuario');

    // SEMANAL: Cada hora, filtra usuarios cuyo lunes local sea a las 10 AM
    this.weeklyCronTask = cron.schedule('0 * * * *', async () => {
      logger.log('[AntExpenseScheduler] 🔄 Ejecutando análisis SEMANAL de gastos hormiga (timezone-aware)...');
      try {
        await this.analyzeAllEligibleUsers('weekly', this.TARGET_HOUR, this.TARGET_MINUTE);
      } catch (error) {
        logger.error('[AntExpenseScheduler] ❌ Error en análisis semanal:', error);
      }
    });

    // MENSUAL: Cada hora, filtra usuarios cuyo día 1 local sea a las 10 AM
    this.monthlyCronTask = cron.schedule('0 * * * *', async () => {
      logger.log('[AntExpenseScheduler] 🔄 Ejecutando análisis MENSUAL de gastos hormiga (timezone-aware)...');
      try {
        await this.analyzeAllEligibleUsers('monthly', this.TARGET_HOUR, this.TARGET_MINUTE);
      } catch (error) {
        logger.error('[AntExpenseScheduler] ❌ Error en análisis mensual:', error);
      }
    });

    this.isRunning = true;
    this.cronTask = this.weeklyCronTask; // Mantener compatibilidad
    logger.log('[AntExpenseScheduler] ✅ Scheduler iniciado correctamente');

    // En desarrollo, ejecutar análisis inicial sin filtros de tiempo
    if (process.env.NODE_ENV === 'development') {
      logger.log('[AntExpenseScheduler] 🧪 Ejecutando análisis inicial (desarrollo - sin filtros)...');
      setTimeout(async () => {
        try {
          await this.analyzeAllEligibleUsers('weekly', -1, 0); // Sin filtro de hora
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
   * Obtiene el día de la semana local para un país
   * @returns 0=Domingo, 1=Lunes, ..., 6=Sábado
   */
  private static getLocalDayOfWeek(country: string | null | undefined): number {
    const timezone = getTimezoneByCountry(country);
    try {
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        weekday: 'short',
      });
      const dayStr = formatter.format(new Date());
      const dayMap: Record<string, number> = {
        'Sun': 0, 'Mon': 1, 'Tue': 2, 'Wed': 3, 'Thu': 4, 'Fri': 5, 'Sat': 6
      };
      return dayMap[dayStr] ?? new Date().getDay();
    } catch {
      return new Date().getDay();
    }
  }

  /**
   * Obtiene el día del mes local para un país
   * @returns 1-31
   */
  private static getLocalDayOfMonth(country: string | null | undefined): number {
    const timezone = getTimezoneByCountry(country);
    try {
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        day: 'numeric',
      });
      return parseInt(formatter.format(new Date()), 10);
    } catch {
      return new Date().getDate();
    }
  }

  /**
   * Analiza gastos hormiga para todos los usuarios elegibles
   * Solo usuarios PRO con alertas habilitadas
   * TIMEZONE-AWARE: Filtra por día y hora local del usuario
   *
   * @param period 'weekly' (7 días) o 'monthly' (30 días)
   * @param targetHour Hora objetivo (0-23) en hora local del usuario. -1 para ignorar filtro
   * @param targetMinute Minuto objetivo (0-59)
   */
  static async analyzeAllEligibleUsers(
    period: 'weekly' | 'monthly' = 'weekly',
    targetHour: number = 10,
    targetMinute: number = 0
  ): Promise<void> {
    const daysToAnalyze = period === 'weekly' ? 7 : 30;
    const periodLabel = period === 'weekly' ? 'SEMANAL' : 'MENSUAL';
    const skipTimeFilter = targetHour === -1;

    logger.log(`[AntExpenseScheduler] 🔍 Análisis ${periodLabel}: Buscando usuarios PRO elegibles ${skipTimeFilter ? '(sin filtro de hora)' : `en ${targetHour}:${targetMinute.toString().padStart(2, '0')} hora local`}...`);

    try {
      // Obtener todos los usuarios con dispositivos activos y alertas habilitadas
      // Incluir country para filtrar por timezone
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
      let usersInTargetTime = 0;

      for (const user of eligibleUsers) {
        try {
          // Filtrar por día de la semana/mes según el período
          if (!skipTimeFilter) {
            if (period === 'weekly') {
              // Para semanal: verificar que sea Lunes en la zona horaria del usuario
              const localDayOfWeek = this.getLocalDayOfWeek(user.country);
              if (localDayOfWeek !== 1) { // 1 = Lunes
                continue;
              }
            } else {
              // Para mensual: verificar que sea día 1 en la zona horaria del usuario
              const localDayOfMonth = this.getLocalDayOfMonth(user.country);
              if (localDayOfMonth !== 1) {
                continue;
              }
            }

            // Verificar si es la hora correcta en la zona horaria del usuario
            if (!isTargetLocalTime(user.country, targetHour, targetMinute)) {
              continue;
            }
          }

          usersInTargetTime++;

          // Verificar horario silencioso (timezone-aware)
          const prefs = user.notificationPreferences;
          if (prefs && isInQuietHours(user.country, prefs.quietHoursStart, prefs.quietHoursEnd)) {
            continue;
          }

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
            // Verificar si hay patrón hormiga real (categoría con 3+ transacciones)
            const hasPattern = calculations.topCriminals.length > 0;

            let topCategory: string;
            let categoryPercentage: number;

            if (hasPattern) {
              // Hay patrón real - usar topCriminals
              topCategory = calculations.topCriminals[0].category;
              categoryPercentage = calculations.percentageOfTotal;
            } else {
              // No hay patrón - usar la categoría con más gasto pequeño
              const topCategoryStat = calculations.allCategoryStats?.[0];
              topCategory = topCategoryStat?.category || 'varios';
              // Porcentaje que representa esta categoría del total de gastos de la semana
              categoryPercentage = calculations.totalAllExpenses > 0
                ? Math.round((topCategoryStat?.total || 0) / calculations.totalAllExpenses * 100)
                : 0;
            }

            await NotificationService.notifyAntExpenseAlert(
              user.id,
              calculations.totalAntExpenses,
              categoryPercentage,
              topCategory,
              calculations.savingsOpportunityPerMonth,
              user.currency || 'RD$',
              period,
              hasPattern
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
      logger.log(`   - Usuarios en día/hora objetivo: ${usersInTargetTime}`);
      logger.log(`   - Notificaciones enviadas: ${notificationsSent}`);
      logger.log(`   - Usuarios sin alertas (bajo umbral o sin datos): ${usersSkipped}`);
      logger.log(`   - Usuarios sin plan PRO: ${usersNotPro}`);

    } catch (error) {
      logger.error(`[AntExpenseScheduler] ❌ Error en análisis ${periodLabel}:`, error);
      throw error;
    }
  }

  /**
   * Ejecuta manualmente el análisis (útil para testing - sin filtros de tiempo)
   * @param period 'weekly' o 'monthly'
   */
  static async runManual(period: 'weekly' | 'monthly' = 'weekly'): Promise<void> {
    logger.log(`[AntExpenseScheduler] 🔧 Ejecutando análisis manual (${period} - sin filtros de tiempo)...`);

    try {
      // -1 = sin filtro de hora/día
      await this.analyzeAllEligibleUsers(period, -1, 0);
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

      // Verificar si hay patrón hormiga real (categoría con 3+ transacciones)
      const hasPattern = calculations.topCriminals.length > 0;

      let topCategory: string;
      let categoryPercentage: number;

      if (hasPattern) {
        // Hay patrón real - usar topCriminals
        topCategory = calculations.topCriminals[0].category;
        categoryPercentage = calculations.percentageOfTotal;
      } else {
        // No hay patrón - usar la categoría con más gasto pequeño
        const topCategoryStat = calculations.allCategoryStats?.[0];
        topCategory = topCategoryStat?.category || 'varios';
        // Porcentaje que representa esta categoría del total de gastos de la semana
        categoryPercentage = calculations.totalAllExpenses > 0
          ? Math.round((topCategoryStat?.total || 0) / calculations.totalAllExpenses * 100)
          : 0;
      }

      await NotificationService.notifyAntExpenseAlert(
        userId,
        calculations.totalAntExpenses,
        categoryPercentage,
        topCategory,
        calculations.savingsOpportunityPerMonth,
        user?.currency || 'RD$',
        period,
        hasPattern
      );

      return {
        sent: true,
        reason: `Alerta ${period} enviada exitosamente`,
        data: {
          period,
          daysAnalyzed: daysToAnalyze,
          hasPattern,
          percentageOfTotal: calculations.percentageOfTotal,
          threshold: alertPercentageThreshold,
          totalAntExpenses: calculations.totalAntExpenses,
          topCategory,
          categoryPercentage,
          topCriminalsCount: calculations.topCriminals.length,
          allCategoriesCount: calculations.allCategoryStats?.length || 0,
          allCategories: calculations.allCategoryStats?.map(c => ({
            category: c.category,
            total: c.total,
            count: c.count,
            percentageOfAntTotal: c.percentageOfAntTotal
          })) || [],
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
  static getStatus(): {
    isRunning: boolean;
    schedules: { weekly: string; monthly: string };
    schedule: string;
  } {
    return {
      isRunning: this.isRunning,
      schedules: {
        weekly: this.isRunning ? 'Cada hora - Lunes 10:00 AM hora local del usuario (últimos 7 días)' : 'Detenido',
        monthly: this.isRunning ? 'Cada hora - Día 1 a las 10:00 AM hora local del usuario (últimos 30 días)' : 'Detenido'
      },
      schedule: 'Timezone-aware: 10:00 AM hora local del usuario'
    };
  }
}
