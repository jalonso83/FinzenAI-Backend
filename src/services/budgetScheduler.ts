import * as cron from 'node-cron';
import { BudgetRenewalService } from './budgetRenewalService';

import { logger } from '../utils/logger';
export class BudgetScheduler {
  private static isRunning: boolean = false;
  private static cronTask: cron.ScheduledTask | null = null;

  /**
   * Inicia el scheduler de renovación de presupuestos
   * Se ejecuta todos los días a la 1 AM UTC para chequear presupuestos vencidos
   */
  static startScheduler(): void {
    if (this.isRunning) {
      logger.log('[BudgetScheduler] Scheduler ya está ejecutándose');
      return;
    }

    logger.log('[BudgetScheduler] 🕐 Iniciando scheduler de renovación de presupuestos...');
    logger.log('[BudgetScheduler] 📅 Se ejecutará diariamente a la 1:00 AM UTC');

    // Ejecutar todos los días a la 1 AM UTC
    // Esto asegura que se chequeen presupuestos en todas las zonas horarias
    this.cronTask = cron.schedule('0 1 * * *', async () => {
      logger.log('[BudgetScheduler] 🔄 Ejecutando renovación de presupuestos...');
      
      try {
        await BudgetRenewalService.renewExpiredBudgets();
      } catch (error) {
        logger.error('[BudgetScheduler] ❌ Error en ejecución del scheduler:', error);
      }
    });

    this.isRunning = true;
    logger.log('[BudgetScheduler] ✅ Scheduler iniciado correctamente');

    // Opcional: Ejecutar una vez al inicio para testing/desarrollo
    if (process.env.NODE_ENV === 'development') {
      logger.log('[BudgetScheduler] 🧪 Ejecutando renovación inicial (desarrollo)...');
      setTimeout(async () => {
        try {
          await BudgetRenewalService.renewExpiredBudgets();
        } catch (error) {
          logger.error('[BudgetScheduler] ❌ Error en renovación inicial:', error);
        }
      }, 5000); // Esperar 5 segundos después del inicio
    }
  }

  /**
   * Detiene el scheduler (útil para testing o shutdown)
   */
  static stopScheduler(): void {
    if (!this.isRunning || !this.cronTask) {
      logger.log('[BudgetScheduler] Scheduler no está ejecutándose');
      return;
    }

    this.cronTask.stop();
    this.cronTask = null;
    this.isRunning = false;
    logger.log('[BudgetScheduler] ⏹️ Scheduler detenido');
  }

  /**
   * Ejecuta manualmente la renovación (útil para testing)
   */
  static async runManual(): Promise<void> {
    logger.log('[BudgetScheduler] 🔧 Ejecutando renovación manual...');
    
    try {
      await BudgetRenewalService.renewExpiredBudgets();
      logger.log('[BudgetScheduler] ✅ Renovación manual completada');
    } catch (error) {
      logger.error('[BudgetScheduler] ❌ Error en renovación manual:', error);
      throw error;
    }
  }

  /**
   * Obtiene el estado del scheduler
   */
  static getStatus(): { isRunning: boolean; nextExecution: string } {
    return {
      isRunning: this.isRunning,
      nextExecution: this.isRunning ? 'Diariamente a la 1:00 AM UTC' : 'Detenido'
    };
  }
}