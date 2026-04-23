import cron from 'node-cron';
import { OpenAiUsageService } from '../services/openAiUsageService';
import { logger } from '../utils/logger';

/**
 * Procesa logs acumulados de OpenAI Usage cada 5 minutos
 * Actualiza tablas UserModelUsage y OpenAIDailyUsage
 */
export function startOpenAiUsageProcessor(): void {
  // Ejecuta cada 5 minutos (*/5 * * * *)
  const job = cron.schedule('*/5 * * * *', async () => {
    try {
      logger.log('[OpenAI Usage Processor] Iniciando procesamiento de logs...');
      await OpenAiUsageService.processAccumulatedUsage();
      logger.log('[OpenAI Usage Processor] ✅ Procesamiento completado');
    } catch (error) {
      logger.error('[OpenAI Usage Processor] ❌ Error en procesamiento:', error);
    }
  });

  logger.log('[OpenAI Usage Processor] 🚀 Iniciado (cada 5 minutos)');
  return;
}

export default startOpenAiUsageProcessor;
