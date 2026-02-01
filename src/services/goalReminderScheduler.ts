import * as cron from 'node-cron';
import { prisma } from '../lib/prisma';
import { NotificationService } from './notificationService';
import { logger } from '../utils/logger';
import { isTargetLocalTime, isInQuietHours, getTimezoneByCountry } from '../utils/timezone';

/**
 * Scheduler para recordatorios de metas
 *
 * TIMEZONE-AWARE: Los usuarios reciben notificaciones a las 6:00 PM
 * de su hora local, según la frecuencia que configuren:
 * - Nunca (0): No se envían recordatorios
 * - Cada 3 días: Domingos y Miércoles
 * - Semanal (7): Solo Domingos
 * - Quincenal (14): Domingos alternos (semanas impares)
 * - Mensual (30): Primer Domingo del mes
 *
 * Hora: 6:00 PM hora local del usuario
 */
export class GoalReminderScheduler {
  private static isRunning: boolean = false;
  private static cronTask: cron.ScheduledTask | null = null;

  // Hora objetivo para enviar recordatorios (6:00 PM hora local del usuario)
  private static readonly TARGET_HOUR = 18; // 6:00 PM
  private static readonly TARGET_MINUTE = 0;

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
   * Obtiene el número de semana del año (1-52)
   */
  private static getWeekNumber(country: string | null | undefined): number {
    const timezone = getTimezoneByCountry(country);
    try {
      const now = new Date();
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
      });
      const localDateStr = formatter.format(now);
      const localDate = new Date(localDateStr);

      const startOfYear = new Date(localDate.getFullYear(), 0, 1);
      const days = Math.floor((localDate.getTime() - startOfYear.getTime()) / (24 * 60 * 60 * 1000));
      return Math.ceil((days + startOfYear.getDay() + 1) / 7);
    } catch {
      const now = new Date();
      const startOfYear = new Date(now.getFullYear(), 0, 1);
      const days = Math.floor((now.getTime() - startOfYear.getTime()) / (24 * 60 * 60 * 1000));
      return Math.ceil((days + startOfYear.getDay() + 1) / 7);
    }
  }

  /**
   * Verifica si hoy corresponde enviar recordatorio según la frecuencia del usuario
   * @param frequency - Frecuencia configurada (0, 3, 7, 14, 30)
   * @param country - País del usuario para timezone
   * @returns true si hoy corresponde enviar
   */
  private static shouldSendToday(frequency: number, country: string | null | undefined): boolean {
    if (frequency === 0) {
      return false; // Nunca
    }

    const dayOfWeek = this.getLocalDayOfWeek(country);
    const dayOfMonth = this.getLocalDayOfMonth(country);
    const weekNumber = this.getWeekNumber(country);

    switch (frequency) {
      case 3:
        // Cada 3 días: Domingos (0) y Miércoles (3)
        return dayOfWeek === 0 || dayOfWeek === 3;

      case 7:
        // Semanal: Solo Domingos
        return dayOfWeek === 0;

      case 14:
        // Quincenal: Domingos de semanas impares
        return dayOfWeek === 0 && weekNumber % 2 === 1;

      case 30:
        // Mensual: Primer Domingo del mes (día 1-7 y que sea Domingo)
        return dayOfWeek === 0 && dayOfMonth <= 7;

      default:
        // Por defecto, semanal
        return dayOfWeek === 0;
    }
  }

  /**
   * Inicia el scheduler de recordatorios de metas
   * Se ejecuta cada hora para capturar usuarios en 6:00 PM local
   */
  static startScheduler(): void {
    if (this.isRunning) {
      logger.log('[GoalReminderScheduler] Scheduler ya está ejecutándose');
      return;
    }

    logger.log('[GoalReminderScheduler] 🎯 Iniciando scheduler de recordatorios de metas...');
    logger.log('[GoalReminderScheduler] 📅 Se ejecutará cada hora - Timezone-aware: 6:00 PM hora local');
    logger.log('[GoalReminderScheduler] 📅 Frecuencias: 3 días (Dom/Mié), Semanal (Dom), Quincenal (Dom alterno), Mensual (1er Dom)');

    // Ejecutar cada hora en el minuto 0 para capturar 6:00 PM en diferentes zonas horarias
    this.cronTask = cron.schedule('0 * * * *', async () => {
      logger.log('[GoalReminderScheduler] 🔄 Ejecutando verificación de recordatorios de metas (timezone-aware)...');

      try {
        await this.checkAllUsersGoals(this.TARGET_HOUR, this.TARGET_MINUTE);
      } catch (error) {
        logger.error('[GoalReminderScheduler] ❌ Error en ejecución del scheduler:', error);
      }
    });

    this.isRunning = true;
    logger.log('[GoalReminderScheduler] ✅ Scheduler iniciado correctamente');

    // Opcional: Ejecutar una vez al inicio para testing/desarrollo (sin filtro de hora)
    if (process.env.NODE_ENV === 'development') {
      logger.log('[GoalReminderScheduler] 🧪 Ejecutando verificación inicial (desarrollo - sin filtro de hora)...');
      setTimeout(async () => {
        try {
          await this.checkAllUsersGoals(-1, 0); // -1 = ignorar filtro de hora
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
   * Solo procesa usuarios cuya hora local y frecuencia configurada coincidan
   *
   * @param targetHour - Hora objetivo (0-23) en hora local del usuario. -1 para ignorar filtro
   * @param targetMinute - Minuto objetivo (0-59)
   */
  static async checkAllUsersGoals(
    targetHour: number = 18,
    targetMinute: number = 0
  ): Promise<void> {
    const skipTimeFilter = targetHour === -1;

    logger.log(`[GoalReminderScheduler] 🔍 Buscando usuarios con recordatorios habilitados ${skipTimeFilter ? '(sin filtro de hora)' : `a las ${targetHour}:${targetMinute.toString().padStart(2, '0')} hora local`}...`);

    try {
      // Obtener usuarios con:
      // - Al menos un dispositivo activo
      // - Recordatorios de metas habilitados
      // - Frecuencia > 0 (0 = nunca)
      // - Incluir país para determinar timezone
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
              gt: 0 // Excluir usuarios con frecuencia "Nunca"
            }
          }
        },
        include: {
          notificationPreferences: true
        }
      });

      logger.log(`[GoalReminderScheduler] 👥 ${eligibleUsers.length} usuarios con recordatorios habilitados (frecuencia > 0)`);

      let notificationsSent = 0;
      let goalsChecked = 0;
      let usersInTargetTime = 0;
      let usersSkippedByFrequency = 0;

      for (const user of eligibleUsers) {
        try {
          const frequency = user.notificationPreferences?.goalReminderFrequency ?? 7;

          // Verificar si hoy corresponde enviar según la frecuencia del usuario
          if (!skipTimeFilter && !this.shouldSendToday(frequency, user.country)) {
            usersSkippedByFrequency++;
            continue; // No es el día correcto según su frecuencia
          }

          // Verificar si es la hora correcta (6:00 PM) en la zona horaria del usuario
          if (!skipTimeFilter && !isTargetLocalTime(user.country, targetHour, targetMinute)) {
            continue; // No es la hora correcta para este usuario
          }

          usersInTargetTime++;

          // Verificar horario silencioso (usa timezone del usuario)
          const prefs = user.notificationPreferences;
          if (prefs && isInQuietHours(user.country, prefs.quietHoursStart, prefs.quietHoursEnd)) {
            continue;
          }

          const result = await this.checkUserGoals(user.id);
          notificationsSent += result.notificationsSent;
          goalsChecked += result.goalsChecked;
        } catch (userError) {
          logger.error(`[GoalReminderScheduler] Error procesando usuario ${user.id}:`, userError);
        }
      }

      logger.log(`[GoalReminderScheduler] ✅ Verificación completada:`);
      logger.log(`   - Usuarios en hora objetivo: ${usersInTargetTime}`);
      logger.log(`   - Usuarios omitidos por frecuencia: ${usersSkippedByFrequency}`);
      logger.log(`   - Metas verificadas: ${goalsChecked}`);
      logger.log(`   - Notificaciones enviadas: ${notificationsSent}`);

    } catch (error) {
      logger.error('[GoalReminderScheduler] ❌ Error verificando usuarios:', error);
      throw error;
    }
  }

  /**
   * Verifica las metas de un usuario específico
   * Envía recordatorio semanal para todas las metas activas no completadas
   */
  private static async checkUserGoals(
    userId: string
  ): Promise<{ goalsChecked: number; notificationsSent: number }> {
    const now = new Date();

    // Obtener metas activas no completadas del usuario
    const goals = await prisma.goal.findMany({
      where: {
        userId,
        isActive: true,
        isCompleted: false
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

      // Calcular días sin contribuir (para información en el log)
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

      // Enviar recordatorio semanal para la meta
      await NotificationService.notifyGoalReminder(
        userId,
        goal.name,
        percentageComplete,
        amountRemaining,
        currency
      );

      notificationsSent++;
      logger.log(`[GoalReminderScheduler] 📨 Recordatorio semanal enviado para meta "${goal.name}" (${percentageComplete}% completado, ${daysSinceLastContribution} días sin contribuir)`);
    }

    return {
      goalsChecked: goals.length,
      notificationsSent
    };
  }

  /**
   * Ejecuta manualmente la verificación (útil para testing)
   * Ignora filtros de hora y frecuencia
   */
  static async runManual(): Promise<void> {
    logger.log('[GoalReminderScheduler] 🔧 Ejecutando verificación manual (sin filtros)...');

    try {
      await this.checkAllUsersGoals(-1, 0); // -1 = ignorar filtros
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

      const result = await this.checkUserGoals(userId);

      return {
        sent: result.notificationsSent > 0,
        goalsChecked: result.goalsChecked,
        notificationsSent: result.notificationsSent,
        reason: result.notificationsSent > 0
          ? `Se enviaron ${result.notificationsSent} recordatorios semanales`
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
  static getStatus(): { isRunning: boolean; nextExecution: string; schedule: string } {
    return {
      isRunning: this.isRunning,
      nextExecution: this.isRunning ? 'Cada hora - 6:00 PM hora local (según frecuencia del usuario)' : 'Detenido',
      schedule: 'Según preferencia: 3 días (Dom/Mié), Semanal (Dom), Quincenal (Dom alterno), Mensual (1er Dom)'
    };
  }
}
