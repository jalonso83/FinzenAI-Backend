import cron from 'node-cron';
import { EmailSyncService, SyncResult } from './emailSyncService';
import { sendInternalAlert } from './emailService';

import { logger } from '../utils/logger';
let schedulerTask: cron.ScheduledTask | null = null;

/** Fracción de conexiones fallidas en una corrida que dispara la alerta. */
const UMBRAL_FALLO_MASIVO = 0.2;
/** Mínimo de conexiones intentadas para que el porcentaje signifique algo. */
const MINIMO_CONEXIONES_PARA_MASIVO = 5;
/** No repetir la misma alerta antes de esto. En memoria: un redeploy la reinicia. */
const HORAS_ENTRE_ALERTAS = 6;
const ultimaAlerta: Record<'configuracion' | 'masivo', number> = { configuracion: 0, masivo: 0 };

export class EmailSyncScheduler {

  /**
   * Inicia el scheduler de sincronizacion de emails
   * Ejecuta cada hora para sincronizar emails de todos los usuarios activos
   */
  static startScheduler(): void {
    if (schedulerTask) {
      logger.log('[EmailSyncScheduler] Scheduler already running');
      return;
    }

    // Ejecutar cada hora en el minuto 0
    // '0 * * * *' = cada hora
    schedulerTask = cron.schedule('0 * * * *', async () => {
      logger.log('[EmailSyncScheduler] Starting scheduled email sync...');
      await this.runSync();
    }, {
      timezone: 'America/Santo_Domingo'
    });

    logger.log('✅ Email Sync Scheduler started (runs every hour)');
  }

  /**
   * Detiene el scheduler
   */
  static stopScheduler(): void {
    if (schedulerTask) {
      schedulerTask.stop();
      schedulerTask = null;
      logger.log('🛑 Email Sync Scheduler stopped');
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

      logger.log(`[EmailSyncScheduler] Found ${connections.length} connections to sync`);

      let successCount = 0;
      let errorCount = 0;
      let totalTransactions = 0;
      const resultados: SyncResult[] = [];

      // Procesar cada conexion
      for (const connection of connections) {
        try {
          logger.log(`[EmailSyncScheduler] Syncing connection ${connection.id} (${connection.email})`);

          const result = await EmailSyncService.syncUserEmails(connection.id);
          resultados.push(result);

          if (result.success) {
            successCount++;
            totalTransactions += result.transactionsCreated;
          } else {
            errorCount++;
          }

          // Pequena pausa entre usuarios para no sobrecargar
          await this.sleep(1000);

        } catch (error: any) {
          logger.error(`[EmailSyncScheduler] Error syncing ${connection.id}:`, error.message);
          errorCount++;
        }
      }

      const duration = ((Date.now() - startTime) / 1000).toFixed(2);

      logger.log(`[EmailSyncScheduler] Sync completed in ${duration}s:`, {
        connections: connections.length,
        success: successCount,
        errors: errorCount,
        transactionsCreated: totalTransactions
      });

      await this.revisarSaludYAlertar(resultados).catch((e) =>
        logger.error('[EmailSyncScheduler] Error evaluando la alerta interna (no bloquea):', e)
      );

    } catch (error: any) {
      logger.error('[EmailSyncScheduler] Fatal error during sync:', error);
    }
  }

  /**
   * Alerta interna por correo (ALERT_EMAILS) cuando la sincronización se cae
   * para muchos a la vez. Dos disparadores:
   * - Error de configuración nuestra (invalid_client): con UNO basta, porque si
   *   el secret de Google/Microsoft está mal, se cae para todos.
   * - Fallo masivo: >= 20 % de las conexiones intentadas (mínimo 5).
   * Los fallos por falta de plan Pro no cuentan: no son una caída.
   */
  static async revisarSaludYAlertar(resultados: SyncResult[]): Promise<void> {
    const intentadas = resultados.filter((r) => !r.omitida && r.tipoFallo !== 'sinPlan');
    const fallidas = intentadas.filter((r) => !r.success);
    const deConfiguracion = fallidas.filter((r) => r.tipoFallo === 'configuracion');
    if (fallidas.length === 0) return;

    const errorMasComun = (() => {
      const conteo = new Map<string, number>();
      for (const r of fallidas) {
        const clave = r.detalleFallo || r.errors[0] || 'Error desconocido';
        conteo.set(clave, (conteo.get(clave) || 0) + 1);
      }
      const [texto, veces] = [...conteo.entries()].sort((a, b) => b[1] - a[1])[0];
      return `${texto} (${veces} ${veces === 1 ? 'vez' : 'veces'})`;
    })();

    const ahora = Date.now();
    const espera = HORAS_ENTRE_ALERTAS * 60 * 60 * 1000;
    const resumen = [
      `Conexiones revisadas en esta corrida: ${intentadas.length}.`,
      `Fallaron: ${fallidas.length} (${Math.round((fallidas.length / intentadas.length) * 100)} %).`,
      `Error más común: ${errorMasComun}.`,
    ];

    if (deConfiguracion.length > 0) {
      if (ahora - ultimaAlerta.configuracion < espera) return;
      ultimaAlerta.configuracion = ahora;
      logger.error(`[EmailSyncScheduler] ALERTA: ${deConfiguracion.length} fallos de configuración OAuth`);
      await sendInternalAlert('La sincronización de correo falla por configuración', [
        `${deConfiguracion.length} conexión(es) fallaron con un error de credenciales de la app (invalid_client).`,
        'Casi seguro el client ID o client secret de Google/Microsoft en Railway está mal, vencido o se rotó sin actualizar la variable. Mientras siga así no entra ningún consumo por correo a nadie.',
        ...resumen,
      ]);
      return;
    }

    const masivo =
      intentadas.length >= MINIMO_CONEXIONES_PARA_MASIVO &&
      fallidas.length / intentadas.length >= UMBRAL_FALLO_MASIVO;
    if (!masivo || ahora - ultimaAlerta.masivo < espera) return;
    ultimaAlerta.masivo = ahora;
    logger.error(`[EmailSyncScheduler] ALERTA: ${fallidas.length}/${intentadas.length} conexiones fallaron`);
    await sendInternalAlert('Muchas conexiones de correo están fallando', [
      'Una parte grande de las conexiones de correo falló en la última sincronización automática. Revisa el log de Railway ([EmailSync] Sync failed).',
      ...resumen,
    ]);
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
    logger.log('[EmailSyncScheduler] Manual sync triggered');

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
