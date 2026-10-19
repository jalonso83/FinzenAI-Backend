import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { GamificationService } from '../services/gamificationService';
import { subscriptionService } from '../services/subscriptionService';

import { logger } from '../utils/logger';
import { aportarAMeta, alBorrarMeta, infoCompartidoDeMetas } from '../services/sharedGoalService';
import { SharedError } from '../services/sharedService';
// Obtener todas las metas del usuario
export const getUserGoals = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    
    if (!userId) {
      res.status(401).json({ error: 'Usuario no autenticado' });
      return;
    }

    const goals = await prisma.goal.findMany({
      where: { 
        userId,
        isActive: true 
      },
      include: {
        category: {
          select: {
            id: true,
            name: true,
            icon: true,
            type: true
          }
        }
      },
      orderBy: {
        createdAt: 'desc'
      }
    });

    // Metas propias que están compartidas. Las que OTROS comparten conmigo van
    // aparte, en GET /api/shared/goals (las apps viejas cuentan esta lista para
    // el límite del plan).
    const compartidas = await infoCompartidoDeMetas(goals.map(g => g.id));
    res.json(goals.map(g => ({ ...g, shared: compartidas.get(g.id) ?? null })));
  } catch (error) {
    logger.error('Error al obtener metas:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

// Obtener una meta específica
export const getGoalById = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({ error: 'Usuario no autenticado' });
      return;
    }

    const goal = await prisma.goal.findFirst({
      where: { 
        id,
        userId 
      },
      include: {
        category: {
          select: {
            id: true,
            name: true,
            icon: true,
            type: true
          }
        }
      }
    });

    if (!goal) {
      res.status(404).json({ error: 'Meta no encontrada' });
      return;
    }

    res.json(goal);
  } catch (error) {
    logger.error('Error al obtener meta:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

// Crear una nueva meta
export const createGoal = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    
    if (!userId) {
      res.status(401).json({ error: 'Usuario no autenticado' });
      return;
    }

    const {
      name,
      description,
      targetAmount,
      targetDate,
      categoryId,
      priority,
      monthlyTargetPercentage,
      monthlyContributionAmount
    } = req.body;

    // Validaciones
    if (!name || !targetAmount || !categoryId) {
      res.status(400).json({ 
        error: 'Nombre, monto objetivo y categoría son requeridos' 
      });
      return;
    }

    if (targetAmount <= 0) {
      res.status(400).json({ 
        error: 'El monto objetivo debe ser mayor a 0' 
      });
      return;
    }

    // Validar que solo uno de los campos mensuales esté definido
    if (monthlyTargetPercentage && monthlyContributionAmount) {
      res.status(400).json({ 
        error: 'Solo puede especificar porcentaje mensual o monto fijo, no ambos' 
      });
      return;
    }

    if (!monthlyTargetPercentage && !monthlyContributionAmount) {
      res.status(400).json({ 
        error: 'Debe especificar un porcentaje mensual o monto fijo' 
      });
      return;
    }

    // Validar porcentaje
    if (monthlyTargetPercentage && (monthlyTargetPercentage < 0 || monthlyTargetPercentage > 100)) {
      res.status(400).json({ 
        error: 'El porcentaje mensual debe estar entre 0 y 100' 
      });
      return;
    }

    // Validar que la categoría existe
    const category = await prisma.category.findUnique({
      where: { id: categoryId }
    });

    if (!category) {
      res.status(400).json({ error: 'Categoría no encontrada' });
      return;
    }

    // Verificar plan del usuario para restricción de prioridades
    // FREE: siempre usa 'medium', PLUS/PRO: puede elegir prioridad
    const subscription = await subscriptionService.getUserSubscription(userId);
    const userPlan = subscription.plan;
    const effectivePriority = userPlan === 'FREE' ? 'medium' : (priority || 'medium');

    const goal = await prisma.goal.create({
      data: {
        userId,
        name,
        description,
        targetAmount: parseFloat(targetAmount),
        targetDate: targetDate ? new Date(targetDate) : null,
        categoryId,
        priority: effectivePriority,
        monthlyTargetPercentage: monthlyTargetPercentage ? parseFloat(monthlyTargetPercentage) : null,
        monthlyContributionAmount: monthlyContributionAmount ? parseFloat(monthlyContributionAmount) : null
      },
      include: {
        category: {
          select: {
            id: true,
            name: true,
            icon: true,
            type: true
          }
        }
      }
    });

    // Disparar evento de gamificación
    try {
      await GamificationService.dispatchEvent({
        userId,
        eventType: 'create_goal',
        eventData: {
          goalId: goal.id,
          targetAmount: goal.targetAmount,
          categoryId: goal.categoryId
        },
        pointsAwarded: 15
      });
    } catch (error) {
      logger.error('Error dispatching gamification event:', error);
      // No fallar la creación de la meta por error de gamificación
    }

    res.status(201).json(goal);
  } catch (error) {
    logger.error('Error al crear meta:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

// Actualizar una meta
export const updateGoal = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = req.user?.id;
    
    if (!userId) {
      res.status(401).json({ error: 'Usuario no autenticado' });
      return;
    }

    const {
      name,
      description,
      targetAmount,
      targetDate,
      categoryId,
      priority,
      monthlyTargetPercentage,
      monthlyContributionAmount
    } = req.body;

    // Verificar que la meta existe y pertenece al usuario
    const existingGoal = await prisma.goal.findFirst({
      where: { id, userId }
    });

    if (!existingGoal) {
      res.status(404).json({ error: 'Meta no encontrada' });
      return;
    }

    // Validar que solo uno de los campos mensuales esté definido
    if (monthlyTargetPercentage && monthlyContributionAmount) {
      res.status(400).json({ 
        error: 'Solo puede especificar porcentaje mensual o monto fijo, no ambos' 
      });
      return;
    }

    if (!monthlyTargetPercentage && !monthlyContributionAmount) {
      res.status(400).json({
        error: 'Debe especificar un porcentaje mensual o monto fijo'
      });
      return;
    }

    // Verificar plan del usuario para restricción de prioridades
    // FREE: siempre usa 'medium', PLUS/PRO: puede elegir prioridad
    const subscription = await subscriptionService.getUserSubscription(userId);
    const userPlan = subscription.plan;
    const effectivePriority = userPlan === 'FREE' ? 'medium' : (priority || existingGoal.priority);

    const updatedGoal = await prisma.goal.update({
      where: { id },
      data: {
        name,
        description,
        targetAmount: targetAmount ? parseFloat(targetAmount) : undefined,
        // Si cambia el objetivo, se recalcula si ya se cumplió. Antes quedaba
        // como estaba: bajar el objetivo por debajo de lo ahorrado dejaba una
        // meta "sin cumplir" a la que nadie podía aportar ("excedería"), y con
        // metas compartidas eso le pasa a todos los miembros.
        isCompleted: targetAmount
          ? existingGoal.currentAmount >= parseFloat(targetAmount) - 0.005
          : undefined,
        targetDate: targetDate ? new Date(targetDate) : null,
        categoryId,
        priority: effectivePriority,
        monthlyTargetPercentage: monthlyTargetPercentage ? parseFloat(monthlyTargetPercentage) : null,
        monthlyContributionAmount: monthlyContributionAmount ? parseFloat(monthlyContributionAmount) : null
      },
      include: {
        category: {
          select: {
            id: true,
            name: true,
            icon: true,
            type: true
          }
        }
      }
    });

    res.json(updatedGoal);
  } catch (error) {
    logger.error('Error al actualizar meta:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

// Eliminar una meta (marcar como inactiva)
export const deleteGoal = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = req.user?.id;
    
    if (!userId) {
      res.status(401).json({ error: 'Usuario no autenticado' });
      return;
    }

    // Verificar que la meta existe y pertenece al usuario
    const existingGoal = await prisma.goal.findFirst({
      where: { id, userId }
    });

    if (!existingGoal) {
      res.status(404).json({ error: 'Meta no encontrada' });
      return;
    }

    // Si estaba compartida, se cierra el compartido y se avisa a los miembros.
    await alBorrarMeta(existingGoal);

    // Marcar como inactiva en lugar de eliminar
    await prisma.goal.update({
      where: { id },
      data: { isActive: false }
    });

    // Restar puntos de gamificación por eliminar meta
    try {
      await GamificationService.dispatchEvent({
        userId,
        eventType: 'create_goal',
        eventData: {
          goalId: existingGoal.id,
          targetAmount: existingGoal.targetAmount,
          categoryId: existingGoal.categoryId,
          action: 'delete'
        },
        pointsAwarded: -15 // Restar 15 puntos
      });
    } catch (error) {
      logger.error('Error dispatching gamification event for delete:', error);
      // No fallar la eliminación por error de gamificación
    }

    res.json({ message: 'Meta eliminada exitosamente' });
  } catch (error) {
    logger.error('Error al eliminar meta:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

// Agregar contribución a una meta (propia, o compartida conmigo)
//
// La lógica vive en sharedGoalService.aportarAMeta: registra quién aportó, no se
// pisa con otro aporte simultáneo, y avisa a los demás si la meta es compartida.
export const addContribution = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { amount } = req.body;
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({ error: 'Usuario no autenticado' });
      return;
    }

    const monto = parseFloat(amount);
    if (!amount || !(monto > 0)) {
      res.status(400).json({ error: 'El monto debe ser mayor a 0' });
      return;
    }

    const updatedGoal = await aportarAMeta(id, userId, monto);
    res.json(updatedGoal);
  } catch (error) {
    if (error instanceof SharedError) {
      // Mismo formato de error que siempre tuvo este endpoint: { error: texto }.
      res.status(error.status).json({ error: error.message, code: error.code, ...error.extra });
      return;
    }
    logger.error('Error al agregar contribución:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};
