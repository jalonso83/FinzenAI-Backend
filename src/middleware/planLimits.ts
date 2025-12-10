import { Request, Response, NextFunction } from 'express';
import { subscriptionService } from '../services/subscriptionService';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Middleware: Verificar límite de presupuestos
 */
export const checkBudgetLimit = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = (req as any).user!.id;

    // Contar presupuestos activos del usuario
    const budgetCount = await prisma.budget.count({
      where: {
        user_id: userId,
        is_active: true,
      },
    });

    // Verificar límite
    const limitCheck = await subscriptionService.checkResourceLimit(
      userId,
      'budgets',
      budgetCount
    );

    if (!limitCheck.allowed) {
      return res.status(403).json({
        message: `Has alcanzado el límite de ${limitCheck.limit} presupuestos activos en tu plan actual`,
        upgrade: true,
        currentPlan: (await subscriptionService.getUserSubscription(userId)).plan,
        limit: limitCheck.limit,
        current: budgetCount,
      });
    }

    next();
  } catch (error: any) {
    console.error('Error verificando límite de presupuestos:', error);
    res.status(500).json({
      message: 'Error al verificar límite',
      error: error.message
    });
  }
};

/**
 * Middleware: Verificar límite de metas
 */
export const checkGoalLimit = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = (req as any).user!.id;

    // Contar metas activas del usuario
    const goalCount = await prisma.goal.count({
      where: {
        userId,
        isActive: true,
      },
    });

    // Verificar límite
    const limitCheck = await subscriptionService.checkResourceLimit(
      userId,
      'goals',
      goalCount
    );

    if (!limitCheck.allowed) {
      return res.status(403).json({
        message: `Has alcanzado el límite de ${limitCheck.limit} metas activas en tu plan actual`,
        upgrade: true,
        currentPlan: (await subscriptionService.getUserSubscription(userId)).plan,
        limit: limitCheck.limit,
        current: goalCount,
      });
    }

    next();
  } catch (error: any) {
    console.error('Error verificando límite de metas:', error);
    res.status(500).json({
      message: 'Error al verificar límite',
      error: error.message
    });
  }
};

/**
 * Middleware: Verificar límite de consultas de Zenio (mensual)
 */
export const checkZenioLimit = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = (req as any).user!.id;

    // Obtener suscripción con contador de Zenio
    const subscription = await subscriptionService.getUserSubscription(userId);
    const limits = subscription.limits as any;
    const zenioLimit = limits.zenioQueries;

    // Si es ilimitado, permitir
    if (zenioLimit === -1) {
      return next();
    }

    // Obtener datos de la suscripción desde la BD para el contador
    const subscriptionData = await prisma.subscription.findUnique({
      where: { userId },
    });

    if (!subscriptionData) {
      return next(); // Si no hay suscripción, permitir (se creará después)
    }

    // Verificar si necesitamos resetear el contador (nuevo mes)
    const now = new Date();
    const resetAt = new Date(subscriptionData.zenioQueriesResetAt);
    const currentMonth = now.getMonth();
    const currentYear = now.getFullYear();
    const resetMonth = resetAt.getMonth();
    const resetYear = resetAt.getFullYear();

    let currentCount = subscriptionData.zenioQueriesUsed;

    // Si cambió el mes, resetear contador
    if (currentYear > resetYear || (currentYear === resetYear && currentMonth > resetMonth)) {
      await prisma.subscription.update({
        where: { userId },
        data: {
          zenioQueriesUsed: 0,
          zenioQueriesResetAt: now,
        },
      });
      currentCount = 0;
    }

    // Verificar límite
    if (currentCount >= zenioLimit) {
      // Calcular fecha de próximo reset (primer día del próximo mes)
      const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);

      return res.status(403).json({
        message: `Has alcanzado el límite de ${zenioLimit} consultas de Zenio este mes`,
        upgrade: true,
        currentPlan: subscription.plan,
        limit: zenioLimit,
        current: currentCount,
        resetDate: nextMonth.toISOString(),
      });
    }

    // Guardar el conteo actual en el request para usarlo después
    (req as any).zenioCurrentCount = currentCount;

    next();
  } catch (error: any) {
    console.error('Error verificando límite de Zenio:', error);
    res.status(500).json({
      message: 'Error al verificar límite',
      error: error.message
    });
  }
};

/**
 * Middleware: Verificar si tiene acceso a reportes avanzados
 */
export const checkAdvancedReports = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = (req as any).user!.id;

    const hasAccess = await subscriptionService.canUseFeature(userId, 'advancedReports');

    if (!hasAccess) {
      return res.status(403).json({
        message: 'Los reportes avanzados solo están disponibles en planes Premium y Pro',
        upgrade: true,
        feature: 'advancedReports',
      });
    }

    next();
  } catch (error: any) {
    console.error('Error verificando acceso a reportes avanzados:', error);
    res.status(500).json({
      message: 'Error al verificar acceso',
      error: error.message
    });
  }
};

/**
 * Middleware: Verificar si tiene acceso a exportar datos
 */
export const checkExportData = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = (req as any).user!.id;

    const hasAccess = await subscriptionService.canUseFeature(userId, 'exportData');

    if (!hasAccess) {
      return res.status(403).json({
        message: 'La exportación de datos solo está disponible en planes Premium y Pro',
        upgrade: true,
        feature: 'exportData',
      });
    }

    next();
  } catch (error: any) {
    console.error('Error verificando acceso a exportación:', error);
    res.status(500).json({
      message: 'Error al verificar acceso',
      error: error.message
    });
  }
};

/**
 * Middleware: Verificar plan mínimo requerido
 */
export const requirePlan = (minPlan: 'FREE' | 'PREMIUM' | 'PRO') => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req as any).user!.id;
      const subscription = await subscriptionService.getUserSubscription(userId);

      const planHierarchy = { FREE: 0, PREMIUM: 1, PRO: 2 };
      const userPlanLevel = planHierarchy[subscription.plan as keyof typeof planHierarchy];
      const requiredLevel = planHierarchy[minPlan];

      if (userPlanLevel < requiredLevel) {
        return res.status(403).json({
          message: `Esta función requiere el plan ${minPlan} o superior`,
          upgrade: true,
          currentPlan: subscription.plan,
          requiredPlan: minPlan,
        });
      }

      next();
    } catch (error: any) {
      console.error('Error verificando plan:', error);
      res.status(500).json({
        message: 'Error al verificar plan',
        error: error.message
      });
    }
  };
};
