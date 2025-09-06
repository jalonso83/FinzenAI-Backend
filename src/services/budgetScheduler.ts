import * as cron from 'node-cron';
import { BudgetRenewalService } from './budgetRenewalService';

export class BudgetScheduler {
  private static isRunning: boolean = false;

  /**
   * Inicia el scheduler de renovación de presupuestos
   * Se ejecuta todos los días a la 1 AM UTC para chequear presupuestos vencidos
   */
  static startScheduler(): void {
    if (this.isRunning) {
      console.log('[BudgetScheduler] Scheduler ya está ejecutándose');
      return;
    }

    console.log('[BudgetScheduler] 🕐 Iniciando scheduler de renovación de presupuestos...');
    console.log('[BudgetScheduler] 📅 Se ejecutará diariamente a la 1:00 AM UTC');

    // Ejecutar todos los días a la 1 AM UTC
    // Esto asegura que se chequeen presupuestos en todas las zonas horarias
    cron.schedule('0 1 * * *', async () => {
      console.log('[BudgetScheduler] 🔄 Ejecutando renovación de presupuestos...');
      
      try {
        await BudgetRenewalService.renewExpiredBudgets();
      } catch (error) {
        console.error('[BudgetScheduler] ❌ Error en ejecución del scheduler:', error);
      }
    });

    this.isRunning = true;
    console.log('[BudgetScheduler] ✅ Scheduler iniciado correctamente');

    // Opcional: Ejecutar una vez al inicio para testing/desarrollo
    if (process.env.NODE_ENV === 'development') {
      console.log('[BudgetScheduler] 🧪 Ejecutando renovación inicial (desarrollo)...');
      setTimeout(async () => {
        try {
          await BudgetRenewalService.renewExpiredBudgets();
        } catch (error) {
          console.error('[BudgetScheduler] ❌ Error en renovación inicial:', error);
        }
      }, 5000); // Esperar 5 segundos después del inicio
    }
  }

  /**
   * Detiene el scheduler (útil para testing o shutdown)
   */
  static stopScheduler(): void {
    if (!this.isRunning) {
      console.log('[BudgetScheduler] Scheduler no está ejecutándose');
      return;
    }

    cron.destroy();
    this.isRunning = false;
    console.log('[BudgetScheduler] ⏹️ Scheduler detenido');
  }

  /**
   * Ejecuta manualmente la renovación (útil para testing)
   */
  static async runManual(): Promise<void> {
    console.log('[BudgetScheduler] 🔧 Ejecutando renovación manual...');
    
    try {
      await BudgetRenewalService.renewExpiredBudgets();
      console.log('[BudgetScheduler] ✅ Renovación manual completada');
    } catch (error) {
      console.error('[BudgetScheduler] ❌ Error en renovación manual:', error);
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