import * as cron from 'node-cron';
import { runDueRecurringTransactions } from './recurringTransactionService';
import { RECURRING_CONFIG } from '../config/recurringConfig';

import { logger } from '../utils/logger';

/**
 * Scheduler de gastos/ingresos recurrentes.
 *
 * Corre CADA HORA, no una vez al día, a propósito: el servicio filtra por la
 * hora local de cada usuario (RUN_LOCAL_HOUR), así todos reciben sus
 * transacciones automáticas a las 6 AM de SU huso y no a las 2 AM de Railway.
 *
 * Efecto secundario deseado del filtro por hora local: para República
 * Dominicana (UTC-4) las 6 AM locales son las 10:00 UTC, muy por detrás de la
 * 1:00 AM UTC en la que BudgetScheduler renueva los presupuestos. Eso importa
 * el día 1 del mes: si el recurrente corriera ANTES de la renovación, el gasto
 * automático se recalcularía contra el presupuesto del mes anterior (ya vencido)
 * en vez de contra el nuevo.
 */
export class RecurringTransactionScheduler {
  private static isRunning: boolean = false;
  private static cronTask: cron.ScheduledTask | null = null;

  static startScheduler(): void {
    if (this.isRunning) {
      logger.log('[RecurringScheduler] Scheduler ya está ejecutándose');
      return;
    }

    if (!RECURRING_CONFIG.ENABLED) {
      logger.log('[RecurringScheduler] ⏸️ Recurrentes deshabilitados (RECURRING_ENABLED=false) — no se inicia');
      return;
    }

    logger.log('[RecurringScheduler] 🕐 Iniciando scheduler de transacciones recurrentes...');
    logger.log(
      `[RecurringScheduler] 📅 Cron "${RECURRING_CONFIG.CRON_SCHEDULE}"; procesa a los usuarios cuya hora local sea las ${RECURRING_CONFIG.RUN_LOCAL_HOUR}:00`
    );

    this.cronTask = cron.schedule(RECURRING_CONFIG.CRON_SCHEDULE, async () => {
      try {
        await runDueRecurringTransactions();
      } catch (error) {
        logger.error('[RecurringScheduler] ❌ Error en ejecución del scheduler:', error);
      }
    });

    this.isRunning = true;
    logger.log('[RecurringScheduler] ✅ Scheduler iniciado correctamente');
  }

  static stopScheduler(): void {
    if (!this.isRunning || !this.cronTask) {
      logger.log('[RecurringScheduler] Scheduler no está ejecutándose');
      return;
    }

    this.cronTask.stop();
    this.cronTask = null;
    this.isRunning = false;
    logger.log('[RecurringScheduler] ⏹️ Scheduler detenido');
  }

  /** Ejecución manual, ignorando el filtro de hora local (testing / soporte). */
  static async runManual(): Promise<{ rulesProcessed: number; transactionsCreated: number }> {
    logger.log('[RecurringScheduler] 🔧 Ejecutando corrida manual...');
    const result = await runDueRecurringTransactions({ ignoreLocalHour: true });
    logger.log(
      `[RecurringScheduler] ✅ Corrida manual completada: ${result.transactionsCreated} transacciones desde ${result.rulesProcessed} reglas`
    );
    return result;
  }

  static getStatus(): { isRunning: boolean; nextExecution: string } {
    return {
      isRunning: this.isRunning,
      nextExecution: this.isRunning
        ? `Cron "${RECURRING_CONFIG.CRON_SCHEDULE}" (procesa a las ${RECURRING_CONFIG.RUN_LOCAL_HOUR}:00 hora local del usuario)`
        : 'Detenido',
    };
  }
}
