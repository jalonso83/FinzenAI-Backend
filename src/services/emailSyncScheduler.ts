import cron from 'node-cron';
import { EmailSyncService } from './emailSyncService';

let schedulerTask: cron.ScheduledTask | null = null;

export class EmailSyncScheduler {

  /**
   * Inicia el scheduler de sincronizacion de emails
   * Ejecuta cada hora para sincronizar emails de todos los usuarios activos
   */
  static startScheduler(): void {
    if (schedulerTask) {
      console.log('[EmailSyncScheduler] Scheduler already running');
      return;
    }

    // Ejecutar cada hora en el minuto 0
    // '0 * * * *' = cada hora
    schedulerTask = cron.schedule('0 * * * *', async () => {
      console.log('[EmailSyncScheduler] Starting scheduled email sync...');
      await this.runSync();
    }, {
      timezone: 'America/Santo_Domingo'
    });

    console.log('✅ Email Sync Scheduler started (runs every hour)');
  }

  /**
   * Detiene el scheduler
   */
  static stopScheduler(): void {
    if (schedulerTask) {
      schedulerTask.stop();
      schedulerTask = null;
      console.log('🛑 Email Sync Scheduler stopped');
    }
  }

  /**
   * Ejecuta la sincronizacion de todos los usuarios activos
   */
  static async runSync(): Promise<void> {
    try {
      const startTime = Date.now();

      // Obtener conexiones activas que necesitan sincronizacion
      const connections = await EmailSyncService.getActiveConnectionsForSync();

      console.log(`[EmailSyncScheduler] Found ${connections.length} connections to sync`);

      let successCount = 0;
      let errorCount = 0;
      let totalTransactions = 0;

      // Procesar cada conexion
      for (const connection of connections) {
        try {
          console.log(`[EmailSyncScheduler] Syncing connection ${connection.id} (${connection.email})`);

          const result = await EmailSyncService.syncUserEmails(connection.id);

          if (result.success) {
            successCount++;
            totalTransactions += result.transactionsCreated;
          } else {
            errorCount++;
          }

          // Pequena pausa entre usuarios para no sobrecargar
          await this.sleep(1000);

        } catch (error: any) {
          console.error(`[EmailSyncScheduler] Error syncing ${connection.id}:`, error.message);
          errorCount++;
        }
      }

      const duration = ((Date.now() - startTime) / 1000).toFixed(2);

      console.log(`[EmailSyncScheduler] Sync completed in ${duration}s:`, {
        connections: connections.length,
        success: successCount,
        errors: errorCount,
        transactionsCreated: totalTransactions
      });

    } catch (error: any) {
      console.error('[EmailSyncScheduler] Fatal error during sync:', error);
    }
  }

  /**
   * Ejecuta sincronizacion manual (para testing o triggers)
   */
  static async triggerManualSync(): Promise<{
    connections: number;
    success: number;
    errors: number;
    transactions: number;
  }> {
    console.log('[EmailSyncScheduler] Manual sync triggered');

    const connections = await EmailSyncService.getActiveConnectionsForSync();
    let successCount = 0;
    let errorCount = 0;
    let totalTransactions = 0;

    for (const connection of connections) {
      try {
        const result = await EmailSyncService.syncUserEmails(connection.id);
        if (result.success) {
          successCount++;
          totalTransactions += result.transactionsCreated;
        } else {
          errorCount++;
        }
      } catch {
        errorCount++;
      }
    }

    return {
      connections: connections.length,
      success: successCount,
      errors: errorCount,
      transactions: totalTransactions
    };
  }

  /**
   * Helper para pausas
   */
  private static sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export default EmailSyncScheduler;
