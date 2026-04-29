import * as cron from 'node-cron';
import { retryPendingEvents } from './attributionEventService';
import { logger } from '../utils/logger';

/**
 * Cron worker que reintenta eventos fallidos de attribution.
 *
 * Corre cada 5 minutos. Solo procesa eventos creados en las últimas 24h
 * (más viejos asumimos que ya no aportan a Meta/TikTok).
 *
 * Compatible con el resto de schedulers del proyecto (mismo patrón).
 */
export class AttributionRetryScheduler {
  private static isRunning = false;
  private static cronTask: cron.ScheduledTask | null = null;
  // Guard de in-flight: previene que dos ticks del cron corran en paralelo
  // (ej. si un tick tarda >5min, el siguiente NO arranca otro batch encima).
  private static isProcessing = false;

  static startScheduler(): void {
    if (this.isRunning) {
      logger.log('[AttributionRetryScheduler] Ya está ejecutándose');
      return;
    }

    logger.log('[AttributionRetryScheduler] 🔄 Iniciando — corre cada 5 minutos');

    // Cada 5 minutos
    this.cronTask = cron.schedule('*/5 * * * *', async () => {
      if (this.isProcessing) {
        logger.warn('[AttributionRetryScheduler] Tick anterior aún procesando, salteando este.');
        return;
      }
      this.isProcessing = true;
      try {
        const result = await retryPendingEvents();
        if (result.processed > 0) {
          logger.log(
            `[AttributionRetryScheduler] Procesados ${result.processed} eventos pendientes — ` +
            `Meta: ${result.metaSent}, TikTok: ${result.tiktokSent}`,
          );
        }
      } catch (error) {
        logger.error('[AttributionRetryScheduler] Error en retry:', error);
      } finally {
        this.isProcessing = false;
      }
    });

    this.isRunning = true;
    logger.log('[AttributionRetryScheduler] ✅ Iniciado correctamente');
  }

  static stopScheduler(): void {
    if (!this.isRunning || !this.cronTask) {
      return;
    }
    this.cronTask.stop();
    this.cronTask = null;
    this.isRunning = false;
    logger.log('[AttributionRetryScheduler] ⏹️ Detenido');
  }

  static getStatus(): { isRunning: boolean } {
    return { isRunning: this.isRunning };
  }
}
