/**
 * Rutas para métricas de costos de OpenAI
 * GET /api/admin/openai-costs - Dashboard metrics
 */

import { Router, Request, Response, type Router as ExpressRouter } from 'express';
import { prisma } from '../lib/prisma';
import { authenticateToken } from '../middlewares/auth';
import { logger } from '../utils/logger';
import { OpenAiUsageService } from '../services/openAiUsageService';
import Decimal from 'decimal.js';

const router: ExpressRouter = Router();

// Mapeo de nombres técnicos a nombres amigables para admin
const FEATURE_DISPLAY_NAMES: Record<string, string> = {
  'zenio_v2': 'Asistente Financiero',
  'zenio_agents': 'Agentes Especializados',
  'email_parser': 'Parser de Emails',
  'weekly_report': 'Reporte Semanal',
  'tts': 'Síntesis de Voz',
  'tip_engine': 'Motor de Consejos',
  'reference_price_service': 'Búsqueda de Precios',
  'zenio_transcription': 'Transcripción de Audio',
};

function getDisplayName(technicalName: string): string {
  return FEATURE_DISPLAY_NAMES[technicalName] || technicalName;
}

/**
 * GET /api/admin/openai-costs
 * Query params: from (YYYY-MM-DD), to (YYYY-MM-DD)
 * Retorna metrics de costos de OpenAI para dashboard
 */
router.get('/', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { from, to } = req.query;

    if (!from || !to) {
      return res.status(400).json({
        error: 'Missing parameters',
        message: 'Se requieren parámetros "from" y "to" en formato YYYY-MM-DD',
      });
    }

    const startDate = new Date(from as string);
    const endDate = new Date(to as string);

    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
      return res.status(400).json({
        error: 'Invalid date format',
        message: 'Las fechas deben estar en formato YYYY-MM-DD',
      });
    }

    endDate.setHours(23, 59, 59, 999);

    // 1. Obtener breakdown completo de costos
    const breakdown = await OpenAiUsageService.getCostBreakdown(startDate, endDate);

    // 2. Obtener tendencia diaria (suma por día)
    const dailyUsageRaw = await prisma.$queryRaw<{ date: Date; total_cost: string }[]>`
      SELECT
        DATE(date) as date,
        SUM(CAST("totalCost" AS NUMERIC)) as total_cost
      FROM "openai_daily_usage"
      WHERE date >= ${startDate} AND date <= ${endDate}
      GROUP BY DATE(date)
      ORDER BY DATE(date) ASC
    `;

    const costTrend = dailyUsageRaw.map((day) => ({
      date: new Date(day.date).toISOString().split('T')[0],
      cost: parseFloat(day.total_cost || '0'),
    }));

    // 3. Obtener top usuarios
    const topUsers = await prisma.openAIDailyUsage.groupBy({
      by: ['userId'],
      where: {
        date: {
          gte: startDate,
          lte: endDate,
        },
      },
      _sum: {
        totalCost: true,
      },
      orderBy: {
        _sum: {
          totalCost: 'desc',
        },
      },
      take: 5,
    });

    // Obtener nombres de usuarios
    const topUserIds = topUsers.map((u) => u.userId);
    const users = await prisma.user.findMany({
      where: { id: { in: topUserIds } },
      select: { id: true, name: true, email: true },
    });

    const userMap = new Map(users.map((u) => [u.id, u.name || u.email]));

    const topUsersData = topUsers
      .filter((u) => u._sum.totalCost !== null)
      .map((u) => ({
        userId: u.userId,
        name: userMap.get(u.userId) || 'Unknown',
        cost: parseFloat(u._sum.totalCost!.toString()),
      }));

    // 4. Detectar anomalías
    const anomalies: Array<{ feature: string; dailyCost: number; reason: string }> = [];

    // Calcular promedio de últimos 7 días
    const sevenDaysAgo = new Date(endDate);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const last7Days = await prisma.openAIDailyUsage.findMany({
      where: {
        date: {
          gte: sevenDaysAgo,
          lt: endDate,
        },
      },
      select: {
        costByFeature: true,
      },
    });

    // Agrupar por feature
    const featureAverages: Record<string, Decimal> = {};
    const featureCounts: Record<string, number> = {};

    last7Days.forEach((day) => {
      if (day.costByFeature) {
        Object.entries(day.costByFeature).forEach(([feature, cost]) => {
          const decCost = new Decimal(cost as any);
          featureAverages[feature] = (featureAverages[feature] || new Decimal(0)).plus(decCost);
          featureCounts[feature] = (featureCounts[feature] || 0) + 1;
        });
      }
    });

    // Calcular promedios
    Object.keys(featureAverages).forEach((feature) => {
      const count = featureCounts[feature] || 1;
      featureAverages[feature] = featureAverages[feature].dividedBy(count);
    });

    // Verificar hoy vs promedio (si existe dato de hoy)
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (endDate.toDateString() === today.toDateString()) {
      const todayData = await prisma.openAIDailyUsage.findFirst({
        where: { date: today },
        select: { costByFeature: true },
      });

      if (todayData?.costByFeature) {
        Object.entries(todayData.costByFeature).forEach(([feature, cost]) => {
          const decCost = new Decimal(cost as any);
          const avgCost = featureAverages[feature];

          if (avgCost && decCost.greaterThan(avgCost.times(2))) {
            // 2x el promedio = anomalía
            const multiplier = decCost.dividedBy(avgCost).toNumber();
            anomalies.push({
              feature: getDisplayName(feature),
              dailyCost: parseFloat(decCost.toString()),
              reason: `${multiplier.toFixed(1)}x el promedio de los últimos 7 días`,
            });
          }
        });
      }
    }

    // 5. Obtener costos por plan
    const costByPlan: Record<string, number> = {
      FREE: 0,
      PREMIUM: 0,
      PRO: 0,
    };

    const usersByPlan = await prisma.user.findMany({
      where: {
        openAIDailyUsage: {
          some: {
            date: {
              gte: startDate,
              lte: endDate,
            },
          },
        },
      },
      select: {
        id: true,
        subscription: {
          select: { plan: true },
        },
      },
    });

    // Calcular costo por usuario y agregar a plan
    for (const user of usersByPlan) {
      const userCost = await OpenAiUsageService.getTotalCostByUser(user.id, startDate, endDate);
      const plan = user.subscription?.plan || 'FREE';
      costByPlan[plan] = (costByPlan[plan] || 0) + parseFloat(userCost.toString());
    }

    // 6. Armar respuesta
    const response = {
      totalCost: parseFloat(breakdown.totalCost.toString()),
      costTrend,
      costByFeature: Object.fromEntries(
        Object.entries(breakdown.byFeature).map(([key, val]) => [
          getDisplayName(key),
          parseFloat(val.toString())
        ])
      ),
      costByModel: Object.fromEntries(
        Object.entries(breakdown.byModel).map(([key, val]) => [key, parseFloat(val.toString())])
      ),
      costByPlan,
      topUsers: topUsersData,
      anomalies,
      period: {
        from: startDate.toISOString().split('T')[0],
        to: endDate.toISOString().split('T')[0],
      },
    };

    logger.log(`[OpenAI Costs] Dashboard metrics requested: ${from} to ${to}`);
    return res.json({ success: true, data: response });
  } catch (error: any) {
    logger.error('[OpenAI Costs] Error fetching metrics:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message || 'Error obteniendo métricas de costos',
    });
  }
});

export default router;
