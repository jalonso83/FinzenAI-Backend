import * as cron from 'node-cron';
import { BudgetReminderService } from './budgetReminderService';
import { logger } from '../utils/logger';

/**
 * Scheduler para recordatorios diarios de presupuesto
 *
 * NIVEL 2 de alertas de presupuesto:
 * Ejecuta diariamente para revisar todos los presupuestos
 * y enviar recordatorios a usuarios cuyos presupuestos
 * están por encima del umbral configurado en sus preferencias.
 */
export class BudgetReminderScheduler {
  private static isRunning: boolean = false;
  private static cronTask: cron.ScheduledTask | null = null;

  /**
   * Inicia el scheduler de recordatorios de presupuesto
   * Se ejecuta todos los días a las 9:30 AM UTC
   */
  static startScheduler(): void {
    if (this.isRunning) {
      logger.log('[BudgetReminderScheduler] Scheduler ya está ejecutándose');
      return;
    }

    logger.log('[BudgetReminderScheduler] 📊 Iniciando scheduler de recordatorios de presupuesto...');
    logger.log('[BudgetReminderScheduler] 📅 Se ejecutará todos los días a las 9:30 AM UTC');

    // Ejecutar todos los días a las 9:30 AM UTC (30 minutos después de goal reminders)
    this.cronTask = cron.schedule('30 9 * * *', async () => {
      logger.log('[BudgetReminderScheduler] 🔄 Ejecutando recordatorios de presupuesto...');

      try {
        const results = await BudgetReminderService.runDailyReminders();
        logger.log(`[BudgetReminderScheduler] ✅ Completado: ${results.remindersSent} recordatorios enviados`);
      } catch (error) {
        logger.error('[BudgetReminderScheduler] ❌ Error en ejecución del scheduler:', error);
      }
    });

    this.isRunning = true;
    logger.log('[BudgetReminderScheduler] ✅ Scheduler iniciado correctamente');

    // En desarrollo, ejecutar una vez después de iniciar
    if (process.env.NODE_ENV === 'development') {
      logger.log('[BudgetReminderScheduler] 🧪 Ejecutando verificación inicial (desarrollo)...');
      setTimeout(async () => {
        try {
          const results = await BudgetReminderService.runDailyReminders();
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
      nextExecution: this.isRunning ? 'Todos los días a las 9:30 AM UTC' : 'Detenido'
    };
  }
}
