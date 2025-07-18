import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Tipos para las peticiones
interface CreateBudgetRequest {
  name: string;
  category_id: string;
  amount: number;
  period: string; // 'monthly', 'weekly', 'yearly'
  start_date: string;
  end_date: string;
  alert_percentage?: number;
}

interface UpdateBudgetRequest {
  name?: string;
  category_id?: string;
  amount?: number;
  period?: string;
  start_date?: string;
  end_date?: string;
  alert_percentage?: number;
  is_active?: boolean;
}

export const getBudgets = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { page = '1', limit = '10', is_active, category_id } = req.query;

    const pageNum = parseInt(page as string);
    const limitNum = parseInt(limit as string);
    const skip = (pageNum - 1) * limitNum;

    // Construir filtros
    const where: any = { user_id: userId };

    if (is_active !== undefined) {
      where.is_active = is_active === 'true';
    }
    if (category_id) {
      where.category_id = category_id;
    }

    // Obtener presupuestos con categoría incluida
    const [budgets, total] = await Promise.all([
      prisma.budget.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip,
        take: limitNum,
        include: {
          category: {
            select: {
              id: true,
              name: true,
              icon: true,
              type: true,
              isDefault: true
            }
          }
        }
      }),
      prisma.budget.count({ where })
    ]);

    return res.json({
      budgets,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum)
      }
    });
  } catch (error) {
    console.error('Get budgets error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to fetch budgets'
    });
  }
};

export const getBudgetById = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;

    const budget = await prisma.budget.findFirst({
      where: {
        id,
        user_id: userId
      },
      include: {
        category: {
          select: {
            id: true,
            name: true,
            icon: true,
            type: true,
            isDefault: true
          }
        }
      }
    });

    if (!budget) {
      return res.status(404).json({
        error: 'Budget not found',
        message: 'Budget does not exist or you do not have access to it'
      });
    }

    return res.json({ budget });
  } catch (error) {
    console.error('Get budget by ID error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to fetch budget'
    });
  }
};

export const createBudget = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { 
      name, 
      category_id, 
      amount, 
      period, 
      start_date, 
      end_date, 
      alert_percentage = 80 
    }: CreateBudgetRequest = req.body;

    // Validaciones
    if (!name || !category_id || !amount || !period || !start_date || !end_date) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'Name, category_id, amount, period, start_date, and end_date are required'
      });
    }

    if (amount <= 0) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'Amount must be greater than 0'
      });
    }

    if (!['monthly', 'weekly', 'yearly'].includes(period)) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'Period must be monthly, weekly, or yearly'
      });
    }

    if (alert_percentage < 0 || alert_percentage > 100) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'Alert percentage must be between 0 and 100'
      });
    }

    // Verificar que la categoría existe
    const category = await prisma.category.findUnique({
      where: { id: category_id }
    });

    if (!category) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'Category does not exist'
      });
    }

    // Verificar fechas
    const startDate = new Date(start_date);
    const endDate = new Date(end_date);

    if (startDate >= endDate) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'Start date must be before end date'
      });
    }

    const budget = await prisma.budget.create({
      data: {
        user_id: userId,
        name,
        category_id,
        amount,
        period,
        start_date: startDate,
        end_date: endDate,
        alert_percentage
      },
      include: {
        category: {
          select: {
            id: true,
            name: true,
            icon: true,
            type: true,
            isDefault: true
          }
        }
      }
    });

    return res.status(201).json({
      message: 'Budget created successfully',
      budget
    });
  } catch (error) {
    console.error('Create budget error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to create budget'
    });
  }
};

export const updateBudget = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;
    const updateData: UpdateBudgetRequest = req.body;

    // Verificar que el presupuesto existe y pertenece al usuario
    const existingBudget = await prisma.budget.findFirst({
      where: {
        id,
        user_id: userId
      }
    });

    if (!existingBudget) {
      return res.status(404).json({
        error: 'Budget not found',
        message: 'Budget does not exist or you do not have access to it'
      });
    }

    // Validaciones
    if (updateData.amount !== undefined && updateData.amount <= 0) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'Amount must be greater than 0'
      });
    }

    if (updateData.period && !['monthly', 'weekly', 'yearly'].includes(updateData.period)) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'Period must be monthly, weekly, or yearly'
      });
    }

    if (updateData.alert_percentage !== undefined && (updateData.alert_percentage < 0 || updateData.alert_percentage > 100)) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'Alert percentage must be between 0 and 100'
      });
    }

    // Si se está actualizando la categoría, verificar que existe
    if (updateData.category_id) {
      const category = await prisma.category.findUnique({
        where: { id: updateData.category_id }
      });

      if (!category) {
        return res.status(400).json({
          error: 'Validation error',
          message: 'Category does not exist'
        });
      }
    }

    // Preparar datos para actualización
    const dataToUpdate: any = { ...updateData };
    
    if (updateData.start_date) {
      dataToUpdate.start_date = new Date(updateData.start_date);
    }
    if (updateData.end_date) {
      dataToUpdate.end_date = new Date(updateData.end_date);
    }

    // Verificar fechas si ambas están siendo actualizadas
    if (updateData.start_date && updateData.end_date) {
      const startDate = new Date(updateData.start_date);
      const endDate = new Date(updateData.end_date);

      if (startDate >= endDate) {
        return res.status(400).json({
          error: 'Validation error',
          message: 'Start date must be before end date'
        });
      }
    }

    const budget = await prisma.budget.update({
      where: { id },
      data: dataToUpdate,
      include: {
        category: {
          select: {
            id: true,
            name: true,
            icon: true,
            type: true,
            isDefault: true
          }
        }
      }
    });

    return res.json({
      message: 'Budget updated successfully',
      budget
    });
  } catch (error) {
    console.error('Update budget error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to update budget'
    });
  }
};

export const deleteBudget = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;

    // Verificar que el presupuesto existe y pertenece al usuario
    const existingBudget = await prisma.budget.findFirst({
      where: {
        id,
        user_id: userId
      }
    });

    if (!existingBudget) {
      return res.status(404).json({
        error: 'Budget not found',
        message: 'Budget does not exist or you do not have access to it'
      });
    }

    await prisma.budget.delete({
      where: { id }
    });

    return res.json({
      message: 'Budget deleted successfully'
    });
  } catch (error) {
    console.error('Delete budget error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to delete budget'
    });
  }
}; 