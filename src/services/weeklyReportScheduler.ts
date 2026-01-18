import * as cron from 'node-cron';
import { prisma } from '../lib/prisma';
import { WeeklyReportService } from './weeklyReportService';
import { NotificationService } from './notificationService';
import { subscriptionService } from './subscriptionService';
import { logger } from '../utils/logger';

/**
 * Scheduler para reportes semanales PRO
 *
 * Ejecuta dos jobs:
 * 1. Domingo 11:00 PM UTC - Genera reportes semanales para usuarios PRO
 * 2. Lunes 8:00 AM UTC - Envía notificaciones de reportes listos
 */
export class WeeklyReportScheduler {
  private static isRunning: boolean = false;
  private static generationTask: cron.ScheduledTask | null = null;
  private static notificationTask: cron.ScheduledTask | null = null;

  /**
   * Inicia los schedulers de reportes semanales
   */
  static startScheduler(): void {
    if (this.isRunning) {
      logger.log('[WeeklyReportScheduler] Scheduler ya está ejecutándose');
      return;
    }

    logger.log('[WeeklyReportScheduler] 📊 Iniciando schedulers de reportes semanales...');

    // Job 1: Generar reportes - Domingo 11:00 PM UTC
    this.generationTask = cron.schedule('0 23 * * 0', async () => {
      logger.log('[WeeklyReportScheduler] 🔄 Ejecutando generación de reportes semanales...');
      await this.runReportGeneration();
    });
    logger.log('[WeeklyReportScheduler] 📅 Generación programada: Domingos 11:00 PM UTC');

    // Job 2: Enviar notificaciones - Lunes 8:00 AM UTC
    this.notificationTask = cron.schedule('0 8 * * 1', async () => {
      logger.log('[WeeklyReportScheduler] 🔔 Ejecutando envío de notificaciones...');
      await this.runNotificationJob();
    });
    logger.log('[WeeklyReportScheduler] 📅 Notificaciones programadas: Lunes 8:00 AM UTC');

    this.isRunning = true;
    logger.log('[WeeklyReportScheduler] ✅ Schedulers iniciados correctamente');

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
      logger.log('[WeeklyReportScheduler] Scheduler no está ejecutándose');
      return;
    }

    if (this.generationTask) {
      this.generationTask.stop();
      this.generationTask = null;
    }

    if (this.notificationTask) {
      this.notificationTask.stop();
      this.notificationTask = null;
    }

    this.isRunning = false;
    logger.log('[WeeklyReportScheduler] ⏹️ Schedulers detenidos');
  }

  /**
   * Obtiene usuarios PRO activos
   */
  private static async getProUsers(): Promise<string[]> {
    const subscriptions = await prisma.subscription.findMany({
      where: {
        status: { in: ['active', 'trialing'] },
        OR: [
          { stripeProductId: { contains: 'pro' } },
          { stripeProductId: { contains: 'PRO' } }
        ]
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
   * Job de envío de notificaciones
   */
  static async runNotificationJob(): Promise<{
    usersNotified: number;
    errors: string[];
  }> {
    const results = {
      usersNotified: 0,
      errors: [] as string[]
    };

    try {
      // Buscar reportes generados esta semana que aún no han sido notificados
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

      logger.log(`[WeeklyReportScheduler] Enviando notificaciones a ${reportsToNotify.length} usuarios`);

      for (const report of reportsToNotify) {
        try {
          // Verificar horario silencioso
          const prefs = report.user.notificationPreferences;
          if (prefs && this.isInQuietHours(prefs)) {
            continue;
          }

          // Enviar notificación
          const score = report.financialScore;
          const emoji = score >= 80 ? '🌟' : score >= 60 ? '📊' : '💡';

          await NotificationService.sendToUser(report.userId, 'WEEKLY_REPORT', {
            title: `${emoji} Tu Reporte Semanal está listo`,
            body: `Score: ${score}/100. Revísalo en Menú > Reportes Semanales para ver tu análisis personalizado.`,
            data: {
              type: 'WEEKLY_REPORT',
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

      logger.log(`[WeeklyReportScheduler] ✅ Notificaciones completadas: ${results.usersNotified}`);

    } catch (error: any) {
      results.errors.push(`Error general: ${error.message}`);
      logger.error('[WeeklyReportScheduler] ❌ Error en envío de notificaciones:', error);
    }

    return results;
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

    if (start > end) {
      return currentHour >= start || currentHour < end;
    }
    return currentHour >= start && currentHour < end;
  }

  /**
   * Ejecución manual para testing
   */
  static async runManual(): Promise<{
    generation: { usersProcessed: number; reportsGenerated: number; errors: string[] };
    notifications: { usersNotified: number; errors: string[] };
  }> {
    logger.log('[WeeklyReportScheduler] 🔧 Ejecutando jobs manualmente...');

    const generation = await this.runReportGeneration();
    const notifications = await this.runNotificationJob();

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
  } {
    return {
      isRunning: this.isRunning,
      nextGeneration: this.isRunning ? 'Domingos 11:00 PM UTC' : 'Detenido',
      nextNotification: this.isRunning ? 'Lunes 8:00 AM UTC' : 'Detenido'
    };
  }
}

export default WeeklyReportScheduler;
