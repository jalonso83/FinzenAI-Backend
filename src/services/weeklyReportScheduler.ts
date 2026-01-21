import * as cron from 'node-cron';
import { prisma } from '../lib/prisma';
import { WeeklyReportService } from './weeklyReportService';
import { NotificationService } from './notificationService';
import { subscriptionService } from './subscriptionService';
import { logger } from '../utils/logger';
import { isTargetLocalTime, isInQuietHours } from '../utils/timezone';

/**
 * Scheduler para reportes QUINCENALES PRO
 *
 * TIMEZONE-AWARE para notificaciones:
 *
 * Ejecuta dos tipos de jobs:
 * 1. GENERACIÓN (UTC fijo): Días 1 y 16 a las 6:00 AM UTC - Genera reportes
 * 2. NOTIFICACIONES (timezone-aware): Cada hora, envía a usuarios en 8:00 AM local
 *
 * Lógica quincenal:
 * - Día 1: Se genera reporte de la segunda quincena del mes anterior (16-fin)
 * - Día 16: Se genera reporte de la primera quincena del mes actual (1-15)
 */
export class WeeklyReportScheduler {
  private static isRunning: boolean = false;
  private static generationTask1: cron.ScheduledTask | null = null;
  private static generationTask16: cron.ScheduledTask | null = null;
  private static notificationTask: cron.ScheduledTask | null = null;

  // Hora objetivo para enviar notificaciones (8:00 AM hora local del usuario)
  private static readonly NOTIFICATION_TARGET_HOUR = 8;
  private static readonly NOTIFICATION_TARGET_MINUTE = 0;

  /**
   * Inicia los schedulers de reportes quincenales
   */
  static startScheduler(): void {
    if (this.isRunning) {
      logger.log('[BiweeklyReportScheduler] Scheduler ya está ejecutándose');
      return;
    }

    logger.log('[BiweeklyReportScheduler] 📊 Iniciando schedulers de reportes quincenales...');

    // Job 1a: Generar reportes - Día 1 del mes a las 6:00 AM UTC
    this.generationTask1 = cron.schedule('0 6 1 * *', async () => {
      logger.log('[BiweeklyReportScheduler] 🔄 Ejecutando generación de reportes (quincena 16-fin mes anterior)...');
      await this.runReportGeneration();
    });

    // Job 1b: Generar reportes - Día 16 del mes a las 6:00 AM UTC
    this.generationTask16 = cron.schedule('0 6 16 * *', async () => {
      logger.log('[BiweeklyReportScheduler] 🔄 Ejecutando generación de reportes (quincena 1-15)...');
      await this.runReportGeneration();
    });
    logger.log('[BiweeklyReportScheduler] 📅 Generación programada: Días 1 y 16 a las 6:00 AM UTC');

    // Job 2: Notificaciones timezone-aware - Cada hora, filtra por hora local del usuario
    // Solo envía a usuarios que tienen reportes pendientes y están en 8:00 AM local
    this.notificationTask = cron.schedule('0 * * * *', async () => {
      logger.log('[BiweeklyReportScheduler] 🔔 Ejecutando envío de notificaciones (timezone-aware)...');
      await this.runNotificationJob(this.NOTIFICATION_TARGET_HOUR, this.NOTIFICATION_TARGET_MINUTE);
    });
    logger.log('[BiweeklyReportScheduler] 📅 Notificaciones: Cada hora - 8:00 AM hora local del usuario');

    this.isRunning = true;
    logger.log('[BiweeklyReportScheduler] ✅ Schedulers iniciados correctamente');

    // En desarrollo, ejecutar verificación inicial después de 30 segundos
    if (process.env.NODE_ENV === 'development') {
      logger.log('[WeeklyReportScheduler] 🧪 Modo desarrollo: verificación inicial en 30 segundos');
      setTimeout(async () => {
        try {
          const proUsers = await this.getProUsers();
          logger.log(`[WeeklyReportScheduler] 🧪 Usuarios PRO encontrados: ${proUsers.length}`);
        } catch (error) {
          logger.error('[WeeklyReportScheduler] ❌ Error en verificación inicial:', error);
        }
      }, 30000);
    }
  }

  /**
   * Detiene los schedulers
   */
  static stopScheduler(): void {
    if (!this.isRunning) {
      logger.log('[BiweeklyReportScheduler] Scheduler no está ejecutándose');
      return;
    }

    if (this.generationTask1) {
      this.generationTask1.stop();
      this.generationTask1 = null;
    }

    if (this.generationTask16) {
      this.generationTask16.stop();
      this.generationTask16 = null;
    }

    if (this.notificationTask) {
      this.notificationTask.stop();
      this.notificationTask = null;
    }

    this.isRunning = false;
    logger.log('[BiweeklyReportScheduler] ⏹️ Schedulers detenidos');
  }

  /**
   * Obtiene usuarios PRO activos
   */
  private static async getProUsers(): Promise<string[]> {
    const subscriptions = await prisma.subscription.findMany({
      where: {
        plan: 'PRO',
        status: { in: ['ACTIVE', 'TRIALING'] }
      },
      select: { userId: true }
    });

    return subscriptions.map(s => s.userId);
  }

  /**
   * Job de generación de reportes
   */
  static async runReportGeneration(): Promise<{
    usersProcessed: number;
    reportsGenerated: number;
    errors: string[];
  }> {
    const results = {
      usersProcessed: 0,
      reportsGenerated: 0,
      errors: [] as string[]
    };

    try {
      // Obtener todos los usuarios PRO
      const proUserIds = await this.getProUsers();
      logger.log(`[WeeklyReportScheduler] Procesando ${proUserIds.length} usuarios PRO`);

      for (const userId of proUserIds) {
        try {
          results.usersProcessed++;

          const result = await WeeklyReportService.generateWeeklyReport(userId);

          if (result.success) {
            results.reportsGenerated++;
            logger.log(`[WeeklyReportScheduler] ✅ Reporte generado para ${userId}`);
          } else {
            logger.log(`[WeeklyReportScheduler] ⚠️ No se generó reporte para ${userId}: ${result.reason}`);
          }

        } catch (userError: any) {
          results.errors.push(`Usuario ${userId}: ${userError.message}`);
          logger.error(`[WeeklyReportScheduler] ❌ Error procesando usuario ${userId}:`, userError);
        }
      }

      logger.log(`[WeeklyReportScheduler] ✅ Generación completada. Reportes: ${results.reportsGenerated}/${results.usersProcessed}`);

    } catch (error: any) {
      results.errors.push(`Error general: ${error.message}`);
      logger.error('[WeeklyReportScheduler] ❌ Error en generación de reportes:', error);
    }

    return results;
  }

  /**
   * Job de envío de notificaciones (timezone-aware)
   * Solo envía a usuarios cuya hora local coincida con la hora objetivo
   *
   * @param targetHour - Hora objetivo (0-23) en hora local del usuario. -1 para ignorar filtro
   * @param targetMinute - Minuto objetivo (0-59)
   */
  static async runNotificationJob(
    targetHour: number = 8,
    targetMinute: number = 0
  ): Promise<{
    usersNotified: number;
    usersInTargetTime: number;
    errors: string[];
  }> {
    const results = {
      usersNotified: 0,
      usersInTargetTime: 0,
      errors: [] as string[]
    };

    const skipTimeFilter = targetHour === -1;

    try {
      logger.log(`[WeeklyReportScheduler] Buscando reportes pendientes de notificación ${skipTimeFilter ? '(sin filtro de hora)' : `para usuarios en ${targetHour}:${targetMinute.toString().padStart(2, '0')} hora local`}...`);

      // Buscar reportes generados esta quincena que aún no han sido notificados
      const { weekStart } = WeeklyReportService.getLastWeekDates();

      const reportsToNotify = await prisma.weeklyReport.findMany({
        where: {
          weekStart,
          notifiedAt: null
        },
        include: {
          user: {
            select: {
              id: true,
              name: true,
              country: true, // Necesario para timezone
              notificationPreferences: {
                select: {
                  tipsEnabled: true,
                  quietHoursStart: true,
                  quietHoursEnd: true
                }
              }
            }
          }
        }
      });

      logger.log(`[WeeklyReportScheduler] ${reportsToNotify.length} reportes pendientes de notificación`);

      for (const report of reportsToNotify) {
        try {
          const userCountry = report.user.country;

          // Verificar si es la hora correcta en la zona horaria del usuario
          if (!skipTimeFilter && !isTargetLocalTime(userCountry, targetHour, targetMinute)) {
            continue; // No es la hora correcta para este usuario
          }

          results.usersInTargetTime++;

          // Verificar horario silencioso (timezone-aware)
          const prefs = report.user.notificationPreferences;
          if (prefs && isInQuietHours(userCountry, prefs.quietHoursStart, prefs.quietHoursEnd)) {
            continue;
          }

          // Enviar notificación
          const score = report.financialScore;
          const emoji = score >= 70 ? '🌟' : score >= 50 ? '📊' : '💡';

          await NotificationService.sendToUser(report.userId, 'WEEKLY_REPORT', {
            title: `${emoji} Tu Reporte Quincenal está listo`,
            body: `Score: ${score}/100. Revísalo en Menú > Reportes para ver tu análisis y proyección a fin de mes.`,
            data: {
              type: 'BIWEEKLY_REPORT',
              reportId: report.id,
              screen: 'WeeklyReports'
            }
          });

          // Marcar como notificado
          await WeeklyReportService.markReportNotified(report.id);
          results.usersNotified++;

          logger.log(`[WeeklyReportScheduler] ✅ Notificación enviada a ${report.user.name}`);

        } catch (notifyError: any) {
          results.errors.push(`Usuario ${report.userId}: ${notifyError.message}`);
          logger.error(`[WeeklyReportScheduler] ❌ Error notificando a ${report.userId}:`, notifyError);
        }
      }

      logger.log(`[WeeklyReportScheduler] ✅ Notificaciones completadas:`);
      logger.log(`   - Usuarios en hora objetivo: ${results.usersInTargetTime}`);
      logger.log(`   - Notificaciones enviadas: ${results.usersNotified}`);

    } catch (error: any) {
      results.errors.push(`Error general: ${error.message}`);
      logger.error('[WeeklyReportScheduler] ❌ Error en envío de notificaciones:', error);
    }

    return results;
  }

  /**
   * Ejecución manual para testing (sin filtro de hora)
   */
  static async runManual(): Promise<{
    generation: { usersProcessed: number; reportsGenerated: number; errors: string[] };
    notifications: { usersNotified: number; usersInTargetTime: number; errors: string[] };
  }> {
    logger.log('[WeeklyReportScheduler] 🔧 Ejecutando jobs manualmente (sin filtro de hora)...');

    const generation = await this.runReportGeneration();
    // En modo manual, no filtramos por hora (-1)
    const notifications = await this.runNotificationJob(-1, 0);

    return { generation, notifications };
  }

  /**
   * Genera reporte para un usuario específico (útil para testing)
   */
  static async generateForUser(userId: string): Promise<any> {
    logger.log(`[WeeklyReportScheduler] 🔧 Generando reporte manual para ${userId}...`);
    return WeeklyReportService.generateWeeklyReport(userId);
  }

  /**
   * Obtiene el estado del scheduler
   */
  static getStatus(): {
    isRunning: boolean;
    nextGeneration: string;
    nextNotification: string;
    schedule: string;
  } {
    return {
      isRunning: this.isRunning,
      nextGeneration: this.isRunning ? 'Días 1 y 16 a las 6:00 AM UTC' : 'Detenido',
      nextNotification: this.isRunning ? 'Cada hora - 8:00 AM hora local del usuario' : 'Detenido',
      schedule: 'Timezone-aware: Notificaciones a las 8:00 AM hora local del usuario'
    };
  }
}

export default WeeklyReportScheduler;
