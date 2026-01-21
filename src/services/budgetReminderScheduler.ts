import * as cron from 'node-cron';
import { BudgetReminderService } from './budgetReminderService';
import { logger } from '../utils/logger';

/**
 * Scheduler para recordatorios diarios de presupuesto
 *
 * NIVEL 2 de alertas de presupuesto:
 * Ejecuta cada hora para revisar usuarios cuya hora local
 * sea las 9:30 AM y enviar recordatorios de presupuestos
 * que están por encima del umbral configurado.
 *
 * TIMEZONE-AWARE: Los usuarios reciben notificaciones a las 9:30 AM
 * de su hora local, basado en su país.
 */
export class BudgetReminderScheduler {
  private static isRunning: boolean = false;
  private static cronTask: cron.ScheduledTask | null = null;

  // Hora objetivo para enviar recordatorios (9:30 AM hora local del usuario)
  private static readonly TARGET_HOUR = 9;
  private static readonly TARGET_MINUTE = 30;

  /**
   * Inicia el scheduler de recordatorios de presupuesto
   * Se ejecuta cada hora a los 30 minutos para capturar usuarios en 9:30 AM local
   */
  static startScheduler(): void {
    if (this.isRunning) {
      logger.log('[BudgetReminderScheduler] Scheduler ya está ejecutándose');
      return;
    }

    logger.log('[BudgetReminderScheduler] 📊 Iniciando scheduler de recordatorios de presupuesto...');
    logger.log('[BudgetReminderScheduler] 📅 Se ejecutará cada hora (minuto 30) - Timezone-aware: 9:30 AM hora local');

    // Ejecutar cada hora en el minuto 30 para capturar 9:30 AM en diferentes zonas horarias
    this.cronTask = cron.schedule('30 * * * *', async () => {
      logger.log('[BudgetReminderScheduler] 🔄 Ejecutando recordatorios de presupuesto (timezone-aware)...');

      try {
        const results = await BudgetReminderService.runDailyReminders(
          this.TARGET_HOUR,
          this.TARGET_MINUTE
        );
        logger.log(`[BudgetReminderScheduler] ✅ Completado: ${results.remindersSent} recordatorios enviados a usuarios en hora local 9:30 AM`);
      } catch (error) {
        logger.error('[BudgetReminderScheduler] ❌ Error en ejecución del scheduler:', error);
      }
    });

    this.isRunning = true;
    logger.log('[BudgetReminderScheduler] ✅ Scheduler iniciado correctamente');

    // En desarrollo, ejecutar una vez después de iniciar (sin filtro de hora para testing)
    if (process.env.NODE_ENV === 'development') {
      logger.log('[BudgetReminderScheduler] 🧪 Ejecutando verificación inicial (desarrollo - sin filtro de hora)...');
      setTimeout(async () => {
        try {
          // En desarrollo, pasar -1 para ignorar filtro de hora y probar con todos
          const results = await BudgetReminderService.runDailyReminders(-1, 0);
          logger.log(`[BudgetReminderScheduler] 🧪 Test: ${results.remindersSent} recordatorios enviados`);
        } catch (error) {
          logger.error('[BudgetReminderScheduler] ❌ Error en verificación inicial:', error);
        }
      }, 20000); // Esperar 20 segundos después del inicio
    }
  }

  /**
   * Detiene el scheduler
   */
  static stopScheduler(): void {
    if (!this.isRunning || !this.cronTask) {
      logger.log('[BudgetReminderScheduler] Scheduler no está ejecutándose');
      return;
    }

    this.cronTask.stop();
    this.cronTask = null;
    this.isRunning = false;
    logger.log('[BudgetReminderScheduler] ⏹️ Scheduler detenido');
  }

  /**
   * Ejecuta manualmente el job (útil para testing)
   */
  static async runManual(): Promise<{
    usersProcessed: number;
    remindersSent: number;
    errors: string[];
  }> {
    logger.log('[BudgetReminderScheduler] 🔧 Ejecutando verificación manual...');

    try {
      const results = await BudgetReminderService.runDailyReminders();
      logger.log('[BudgetReminderScheduler] ✅ Verificación manual completada');
      return results;
    } catch (error: any) {
      logger.error('[BudgetReminderScheduler] ❌ Error en verificación manual:', error);
      throw error;
    }
  }

  /**
   * Obtiene el estado del scheduler
   */
  static getStatus(): { isRunning: boolean; nextExecution: string } {
    return {
      isRunning: this.isRunning,
      nextExecution: this.isRunning ? 'Cada hora (minuto 30) - 9:30 AM hora local del usuario' : 'Detenido'
    };
  }
}
