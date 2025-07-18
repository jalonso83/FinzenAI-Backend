import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Función utilitaria para recalcular el gasto de los presupuestos afectados
async function recalculateBudgetSpent(userId: string, categoryId: string, date: Date) {
  // Buscar presupuestos activos de la categoría y usuario cuyo período incluya la fecha
  const budgets = await prisma.budget.findMany({
    where: {
      user_id: userId,
      category_id: categoryId,
      is_active: true,
      start_date: { lte: date },
      end_date: { gte: date }
    }
  });

  for (const budget of budgets) {
    // Sumar todas las transacciones de gasto de esa categoría, usuario y período
    const spent = await prisma.transaction.aggregate({
      _sum: { amount: true },
      where: {
        userId,
        category_id: categoryId,
        type: 'EXPENSE',
        date: {
          gte: budget.start_date,
          lte: budget.end_date
        }
      }
    });
    await prisma.budget.update({
      where: { id: budget.id },
      data: { spent: spent._sum.amount || 0 }
    });
  }
}

// Tipos para las peticiones
interface CreateTransactionRequest {
  amount: number;
  type: 'INCOME' | 'EXPENSE';
  category_id: string;
  description?: string;
  date?: string;
}

interface UpdateTransactionRequest {
  amount?: number;
  type?: 'INCOME' | 'EXPENSE';
  category_id?: string;
  description?: string;
  date?: string;
}

export const getTransactions = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { page = '1', limit = '10', type, category_id, startDate, endDate } = req.query;

    const pageNum = parseInt(page as string);
    const limitNum = parseInt(limit as string);
    const skip = (pageNum - 1) * limitNum;

    // Construir filtros
    const where: any = { userId };

    if (type) where.type = type;
    if (category_id) where.category_id = category_id;
    if (startDate || endDate) {
      where.date = {};
      if (startDate) {
        const start = new Date(startDate as string);
        start.setHours(0, 0, 0, 0);
        where.date.gte = start;
      }
      if (endDate) {
        const end = new Date(endDate as string);
        end.setHours(23, 59, 59, 999);
        where.date.lte = end;
      }
    }

    // Obtener transacciones con categoría incluida
    const [transactions, total] = await Promise.all([
      prisma.transaction.findMany({
        where,
        orderBy: { date: 'desc' },
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
      prisma.transaction.count({ where })
    ]);

    return res.json({
      transactions,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum)
      }
    });
  } catch (error) {
    console.error('Get transactions error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to fetch transactions'
    });
  }
};

export const getTransactionById = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;

    const transaction = await prisma.transaction.findFirst({
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
            type: true,
            isDefault: true
          }
        }
      }
    });

    if (!transaction) {
      return res.status(404).json({
        error: 'Transaction not found',
        message: 'Transaction does not exist or you do not have access to it'
      });
    }

    return res.json({ transaction });
  } catch (error) {
    console.error('Get transaction by ID error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to fetch transaction'
    });
  }
};

export const createTransaction = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { amount, type, category_id, description, date }: CreateTransactionRequest = req.body;

    // Validaciones
    if (!amount || !type || !category_id) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'Amount, type, and category_id are required'
      });
    }

    if (amount <= 0) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'Amount must be greater than 0'
      });
    }

    if (!['INCOME', 'EXPENSE'].includes(type)) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'Type must be either INCOME or EXPENSE'
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

    const transaction = await prisma.transaction.create({
      data: {
        userId,
        amount,
        type,
        category_id,
        description,
        date: date ? new Date(date) : new Date()
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

    // Recalcular presupuesto si es gasto
    if (type === 'EXPENSE') {
      await recalculateBudgetSpent(userId, category_id, transaction.date);
    }

    return res.status(201).json({
      message: 'Transaction created successfully',
      transaction
    });
  } catch (error) {
    console.error('Create transaction error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to create transaction'
    });
  }
};

export const updateTransaction = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;
    const updateData: UpdateTransactionRequest = req.body;

    // Verificar que la transacción existe y pertenece al usuario
    const existingTransaction = await prisma.transaction.findFirst({
      where: {
        id,
        userId
      }
    });

    if (!existingTransaction) {
      return res.status(404).json({
        error: 'Transaction not found',
        message: 'Transaction does not exist or you do not have access to it'
      });
    }

    // Validaciones
    if (updateData.amount !== undefined && updateData.amount <= 0) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'Amount must be greater than 0'
      });
    }

    if (updateData.type && !['INCOME', 'EXPENSE'].includes(updateData.type)) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'Type must be either INCOME or EXPENSE'
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

    const transaction = await prisma.transaction.update({
      where: { id },
      data: {
        ...updateData,
        date: updateData.date ? new Date(updateData.date) : undefined
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

    // Si la transacción original o la nueva es de gasto, recalcular ambos presupuestos
    if ((existingTransaction?.type === 'EXPENSE' || transaction.type === 'EXPENSE')) {
      // Recalcular para la categoría y fecha original
      if (existingTransaction?.type === 'EXPENSE') {
        await recalculateBudgetSpent(userId, existingTransaction.category_id, existingTransaction.date);
      }
      // Recalcular para la nueva categoría y fecha si cambió
      if (transaction.type === 'EXPENSE') {
        await recalculateBudgetSpent(userId, transaction.category_id, transaction.date);
      }
    }

    return res.json({
      message: 'Transaction updated successfully',
      transaction
    });
  } catch (error) {
    console.error('Update transaction error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to update transaction'
    });
  }
};

export const deleteTransaction = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;

    // Obtener la transacción antes de eliminarla
    const existingTransaction = await prisma.transaction.findFirst({
      where: {
        id,
        userId
      }
    });

    if (!existingTransaction) {
      return res.status(404).json({
        error: 'Transaction not found',
        message: 'Transaction does not exist or you do not have access to it'
      });
    }

    await prisma.transaction.delete({
      where: { id }
    });

    // Si era gasto, recalcular presupuesto
    if (existingTransaction.type === 'EXPENSE') {
      await recalculateBudgetSpent(userId, existingTransaction.category_id, existingTransaction.date);
    }

    return res.json({
      message: 'Transaction deleted successfully'
    });
  } catch (error) {
    console.error('Delete transaction error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to delete transaction'
    });
  }
}; 