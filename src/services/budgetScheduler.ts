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
    logger.log('[BudgetScheduler] 📅 Se ejecutará cada hora, en el minuto 5');

    // ─── Cada hora, no una vez al día (2026-08-11) ─────────────────────────────
    //
    // Antes corría solo a la 01:00 UTC. Funcionaba por accidente: las ventanas
    // terminaban a las 23:59 UTC, justo antes de la siguiente pasada. Al corregir
    // las fronteras para que caigan en la medianoche LOCAL de cada usuario, esa
    // hora fija dejó de encajar: un presupuesto de RD cierra a las 03:59 UTC, o
    // sea DESPUÉS de la pasada de la 01:00, y se quedaba sin renovar hasta el día
    // siguiente — unas 21 horas sin ventana vigente. En España o México el
    // desajuste va en la otra dirección.
    //
    // Cada hora sirve para todos los husos sin casos especiales. Correr más veces
    // es inofensivo: `renewExpiredBudgets` solo toca lo que ya venció, y el
    // compare-and-swap impide que dos pasadas rendundantes dupliquen nada.
    //
    // Minuto 5 para no chocar con los demás schedulers que arrancan en punto.
    this.cronTask = cron.schedule('5 * * * *', async () => {
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
      nextExecution: this.isRunning ? 'Cada hora, en el minuto 5 (UTC)' : 'Detenido'
    };
  }
}