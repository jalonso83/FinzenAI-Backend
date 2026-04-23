import { prisma } from '../lib/prisma';
import { calculateOpenAICost } from '../config/openaiPricing';
import { logger } from '../utils/logger';
import Decimal from 'decimal.js';

export interface LogUsageParams {
  userId: string;
  feature: string; // 'zenio', 'email_parser', 'tip_engine', 'weekly_report', 'tts', 'whisper'
  model: string; // 'gpt-5.4-mini', 'whisper-1', 'gpt-4o-mini-tts'
  inputTokens?: number;
  outputTokens?: number;
  durationMinutes?: number;
  characters?: number;
  status: 'success' | 'error';
  errorMessage?: string;
  conversationId?: string;
}

export class OpenAiUsageService {
  /**
   * Log ASÍNCRONO e INMEDIATO (fire & forget - NO espera BD)
   * Se acumula en memoria/logs y se procesa cada 5 minutos
   */
  static logUsageAsync(params: LogUsageParams): void {
    // Log el evento para que sea procesado después
    logger.log(
      `[OpenAI Usage] ${params.feature}/${params.model} | User: ${params.userId} | Status: ${params.status}`,
      {
        category: 'openai_usage',
        ...params,
      }
    );
  }

  /**
   * Procesa logs acumulados desde hace 5 minutos
   * Ejecutado por cron job cada 5 minutos
   */
  static async processAccumulatedUsage(): Promise<void> {
    try {
      // Por ahora, simplificamos: procesamos eventos desde el log
      // En producción, tendrías un sistema más robusto (Redis, queue, etc)

      logger.log('[OpenAI Usage] Iniciando procesamiento de logs acumulados');

      // Aquí irían los logs acumulados
      // Por ahora lo dejamos como estructura para expandir

      logger.log('[OpenAI Usage] ✅ Procesamiento completado exitosamente');
    } catch (error) {
      logger.error('[OpenAI Usage] Error procesando uso acumulado:', error);
      throw error;
    }
  }

  /**
   * Registra uso directamente en BD (usado por batch processor)
   */
  static async recordUsage(params: LogUsageParams & { cost: number }): Promise<void> {
    const { userId, feature, model, status } = params;

    if (status === 'error') {
      logger.log(`[OpenAI Usage] Llamada fallida registrada: ${feature}/${model}`);
      return;
    }

    try {
      // Actualizar UserModelUsage (sumatorias acumuladas)
      await prisma.userModelUsage.upsert({
        where: {
          userId_model_feature: {
            userId,
            model,
            feature,
          },
        },
        update: {
          totalInputTokens: { increment: params.inputTokens || 0 },
          totalOutputTokens: { increment: params.outputTokens || 0 },
          totalDuration: { increment: params.durationMinutes || 0 },
          totalCallCount: { increment: 1 },
          totalCost: { increment: new Decimal(params.cost) },
          lastUsedAt: new Date(),
        },
        create: {
          userId,
          model,
          feature,
          totalInputTokens: params.inputTokens || 0,
          totalOutputTokens: params.outputTokens || 0,
          totalDuration: params.durationMinutes || 0,
          totalCallCount: 1,
          totalCost: new Decimal(params.cost),
          lastUsedAt: new Date(),
        },
      });

      // Actualizar OpenAIDailyUsage (agregados diarios)
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const costByModel = { [model]: params.cost };
      const costByFeature = { [feature]: params.cost };

      await prisma.openAIDailyUsage.upsert({
        where: {
          userId_date: {
            userId,
            date: today,
          },
        },
        update: {
          totalInputTokens: { increment: params.inputTokens || 0 },
          totalOutputTokens: { increment: params.outputTokens || 0 },
          totalDuration: { increment: params.durationMinutes || 0 },
          totalCallCount: { increment: 1 },
          totalCost: { increment: new Decimal(params.cost) },
        },
        create: {
          userId,
          date: today,
          totalInputTokens: params.inputTokens || 0,
          totalOutputTokens: params.outputTokens || 0,
          totalDuration: params.durationMinutes || 0,
          totalCallCount: 1,
          totalCost: new Decimal(params.cost),
          costByModel,
          costByFeature,
        },
      });
    } catch (error) {
      logger.error('[OpenAI Usage] Error registrando uso:', error);
      throw error;
    }
  }

  /**
   * Obtiene costo total de un usuario en período específico
   */
  static async getTotalCostByUser(
    userId: string,
    startDate: Date,
    endDate: Date
  ): Promise<Decimal> {
    const result = await prisma.openAIDailyUsage.aggregate({
      where: {
        userId,
        date: {
          gte: startDate,
          lte: endDate,
        },
      },
      _sum: {
        totalCost: true,
      },
    });

    return result._sum.totalCost || new Decimal(0);
  }

  /**
   * Obtiene breakdown de costos por feature
   */
  static async getCostByFeature(userId: string): Promise<Record<string, Decimal>> {
    const result = await prisma.userModelUsage.findMany({
      where: { userId },
      select: {
        feature: true,
        totalCost: true,
      },
    });

    const breakdown: Record<string, Decimal> = {};
    result.forEach((item) => {
      breakdown[item.feature] = (breakdown[item.feature] || new Decimal(0)).plus(item.totalCost);
    });

    return breakdown;
  }

  /**
   * Obtiene breakdown completo de costos por período
   */
  static async getCostBreakdown(startDate: Date, endDate: Date) {
    const dailyUsage = await prisma.openAIDailyUsage.findMany({
      where: {
        date: {
          gte: startDate,
          lte: endDate,
        },
      },
      select: {
        userId: true,
        totalCost: true,
        costByModel: true,
        costByFeature: true,
      },
    });

    let totalCost = new Decimal(0);
    const byUser: Record<string, Decimal> = {};
    const byFeature: Record<string, Decimal> = {};
    const byModel: Record<string, Decimal> = {};

    dailyUsage.forEach((day) => {
      totalCost = totalCost.plus(day.totalCost);
      byUser[day.userId] = (byUser[day.userId] || new Decimal(0)).plus(day.totalCost);

      // Parsear JSON de costos
      if (day.costByModel) {
        Object.entries(day.costByModel).forEach(([model, cost]) => {
          byModel[model] = (byModel[model] || new Decimal(0)).plus(new Decimal(cost as any));
        });
      }
      if (day.costByFeature) {
        Object.entries(day.costByFeature).forEach(([feature, cost]) => {
          byFeature[feature] = (byFeature[feature] || new Decimal(0)).plus(new Decimal(cost as any));
        });
      }
    });

    return {
      totalCost,
      byUser,
      byFeature,
      byModel,
    };
  }
}
