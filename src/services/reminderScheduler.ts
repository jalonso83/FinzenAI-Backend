import * as cron from 'node-cron';
import { ReminderService } from './reminderService';

import { logger } from '../utils/logger';
export class ReminderScheduler {
  private static isRunning: boolean = false;
  private static cronTask: cron.ScheduledTask | null = null;

  /**
   * Inicia el scheduler de recordatorios de pago
   * Se ejecuta todos los días a las 8:00 AM UTC (4:00 AM República Dominicana)
   * para que las notificaciones lleguen temprano en la mañana
   */
  static startScheduler(): void {
    if (this.isRunning) {
      logger.log('[ReminderScheduler] Scheduler ya está ejecutándose');
      return;
    }

    logger.log('[ReminderScheduler] Iniciando scheduler de recordatorios de pago...');
    logger.log('[ReminderScheduler] Se ejecutará diariamente a las 8:00 AM UTC');

    // Ejecutar todos los días a las 8 AM UTC
    // En República Dominicana (UTC-4) esto es a las 4:00 AM
    this.cronTask = cron.schedule('0 8 * * *', async () => {
      logger.log('[ReminderScheduler] Ejecutando procesamiento de recordatorios...');

      try {
        const result = await ReminderService.processPaymentReminders();
        logger.log(`[ReminderScheduler] Procesamiento completado: ${result.notificationsSent} notificaciones enviadas`);

        if (result.errors.length > 0) {
          logger.warn('[ReminderScheduler] Errores durante procesamiento:', result.errors);
        }
      } catch (error) {
        logger.error('[ReminderScheduler] Error en ejecución del scheduler:', error);
      }
    });

    this.isRunning = true;
    logger.log('[ReminderScheduler] Scheduler iniciado correctamente');
  }

  /**
   * Detiene el scheduler
   */
  static stopScheduler(): void {
    if (!this.isRunning || !this.cronTask) {
      logger.log('[ReminderScheduler] Scheduler no está ejecutándose');
      return;
    }

    this.cronTask.stop();
    this.cronTask = null;
    this.isRunning = false;
    logger.log('[ReminderScheduler] Scheduler detenido');
  }

  /**
   * Ejecuta manualmente el procesamiento de recordatorios
   */
  static async runManual(): Promise<{
    processed: number;
    notificationsSent: number;
    errors: string[];
  }> {
    logger.log('[ReminderScheduler] Ejecutando procesamiento manual...');

    try {
      const result = await ReminderService.processPaymentReminders();
      logger.log('[ReminderScheduler] Procesamiento manual completado');
      return result;
    } catch (error) {
      logger.error('[ReminderScheduler] Error en procesamiento manual:', error);
      throw error;
    }
  }

  /**
   * Obtiene el estado del scheduler
   */
  static getStatus(): {
    isRunning: boolean;
    nextExecution: string;
    schedule: string;
  } {
    return {
      isRunning: this.isRunning,
      nextExecution: this.isRunning ? 'Diariamente a las 8:00 AM UTC' : 'Detenido',
      schedule: '0 8 * * *'
    };
  }
}

export default ReminderScheduler;
