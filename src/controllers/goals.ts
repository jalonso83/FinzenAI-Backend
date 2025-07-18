import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

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

    res.json(goals);
  } catch (error) {
    console.error('Error al obtener metas:', error);
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
    console.error('Error al obtener meta:', error);
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

    const goal = await prisma.goal.create({
      data: {
        userId,
        name,
        description,
        targetAmount: parseFloat(targetAmount),
        targetDate: targetDate ? new Date(targetDate) : null,
        categoryId,
        priority: priority || 'medium',
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

    res.status(201).json(goal);
  } catch (error) {
    console.error('Error al crear meta:', error);
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

    const updatedGoal = await prisma.goal.update({
      where: { id },
      data: {
        name,
        description,
        targetAmount: targetAmount ? parseFloat(targetAmount) : undefined,
        targetDate: targetDate ? new Date(targetDate) : null,
        categoryId,
        priority,
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
    console.error('Error al actualizar meta:', error);
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

    // Marcar como inactiva en lugar de eliminar
    await prisma.goal.update({
      where: { id },
      data: { isActive: false }
    });

    res.json({ message: 'Meta eliminada exitosamente' });
  } catch (error) {
    console.error('Error al eliminar meta:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

// Agregar contribución a una meta
export const addContribution = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { amount } = req.body;
    const userId = req.user?.id;
    
    if (!userId) {
      res.status(401).json({ error: 'Usuario no autenticado' });
      return;
    }

    if (!amount || amount <= 0) {
      res.status(400).json({ error: 'El monto debe ser mayor a 0' });
      return;
    }

    // Verificar que la meta existe y pertenece al usuario
    const existingGoal = await prisma.goal.findFirst({
      where: { id, userId, isActive: true }
    });

    if (!existingGoal) {
      res.status(404).json({ error: 'Meta no encontrada' });
      return;
    }

    // Verificar que no exceda el monto objetivo
    const newCurrentAmount = existingGoal.currentAmount + parseFloat(amount);
    if (newCurrentAmount > existingGoal.targetAmount) {
      res.status(400).json({ 
        error: 'La contribución excedería el monto objetivo de la meta' 
      });
      return;
    }

    const updatedGoal = await prisma.goal.update({
      where: { id },
      data: {
        currentAmount: newCurrentAmount,
        contributionsCount: existingGoal.contributionsCount + 1,
        lastContributionDate: new Date(),
        isCompleted: newCurrentAmount >= existingGoal.targetAmount
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
    console.error('Error al agregar contribución:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
}; 