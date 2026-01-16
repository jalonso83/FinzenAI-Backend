import { Request, Response } from 'express';
import { MappingSource } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { GamificationService } from '../services/gamificationService';
import { NotificationService } from '../services/notificationService';
import { merchantMappingService } from '../services/merchantMappingService';
import { sanitizeLimit, sanitizePage, PAGINATION } from '../config/pagination';

import { logger } from '../utils/logger';
// Función inteligente para analizar y disparar eventos de gamificación
export async function analyzeAndDispatchTransactionEvents(userId: string, transaction: any) {
  const today = new Date();
  const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const endOfDay = new Date(startOfDay);
  endOfDay.setDate(endOfDay.getDate() + 1);
  
  // Obtener estadísticas necesarias para análisis
  const [
    todayTransactions,
    weekTransactions,
    monthTransactions,
    totalTransactions,
    categoriesUsedToday,
    totalCategories,
    weeklyBalance,
    monthlyFirstIncome,
    consecutiveDays
  ] = await Promise.all([
    // Transacciones de hoy
    prisma.transaction.count({
      where: { userId, date: { gte: startOfDay, lt: endOfDay } }
    }),
    
    // Transacciones de esta semana
    prisma.transaction.count({
      where: { 
        userId, 
        date: { 
          gte: new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000) 
        } 
      }
    }),
    
    // Transacciones de este mes
    prisma.transaction.count({
      where: { 
        userId, 
        date: { 
          gte: new Date(today.getFullYear(), today.getMonth(), 1) 
        } 
      }
    }),
    
    // Total de transacciones del usuario
    prisma.transaction.count({ where: { userId } }),
    
    // Categorías diferentes usadas hoy
    prisma.transaction.findMany({
      where: { userId, date: { gte: startOfDay, lt: endOfDay } },
      select: { category_id: true },
      distinct: ['category_id']
    }),
    
    // Total de categorías disponibles
    prisma.category.count(),
    
    // Balance de la semana (placeholder - se calcula después)
    Promise.resolve(null),
    
    // Primer ingreso del mes
    prisma.transaction.findFirst({
      where: { 
        userId, 
        type: 'INCOME',
        date: { 
          gte: new Date(today.getFullYear(), today.getMonth(), 1) 
        } 
      },
      orderBy: { date: 'asc' }
    }),
    
    // Calcular días consecutivos (simplificado)
    calculateConsecutiveDays(userId)
  ]);

  // ===== EVENTO BASE: Crear transacción =====
  await GamificationService.dispatchEvent({
    userId,
    eventType: 'add_tx',
    eventData: { transactionId: transaction.id },
    pointsAwarded: 5
  });

  // ===== 1. EVENTOS DE CANTIDAD/FRECUENCIA =====
  
  // Primera transacción del día
  if (todayTransactions === 1) {
    await GamificationService.dispatchEvent({
      userId,
      eventType: 'add_tx',
      eventData: { milestone: 'first_today' },
      pointsAwarded: 3
    });
  }
  
  // 5 transacciones en un día
  if (todayTransactions === 5) {
    await GamificationService.dispatchEvent({
      userId,
      eventType: 'add_tx',
      eventData: { milestone: '5_per_day' },
      pointsAwarded: 10
    });
  }
  
  // 10 transacciones en una semana
  if (weekTransactions === 10) {
    await GamificationService.dispatchEvent({
      userId,
      eventType: 'add_tx',
      eventData: { milestone: '10_per_week' },
      pointsAwarded: 15
    });
  }
  
  // 50 transacciones en un mes
  if (monthTransactions === 50) {
    await GamificationService.dispatchEvent({
      userId,
      eventType: 'add_tx',
      eventData: { milestone: '50_per_month' },
      pointsAwarded: 25
    });
  }
  
  // 100 transacciones totales
  if (totalTransactions === 100) {
    await GamificationService.dispatchEvent({
      userId,
      eventType: 'add_tx',
      eventData: { milestone: '100_total' },
      pointsAwarded: 50
    });
  }

  // ===== 2. EVENTOS DE CONSISTENCIA =====
  
  // Días consecutivos
  if (consecutiveDays === 3) {
    await GamificationService.dispatchEvent({
      userId,
      eventType: 'consecutive_days',
      eventData: { days: 3 },
      pointsAwarded: 15
    });
  }
  
  if (consecutiveDays === 7) {
    await GamificationService.dispatchEvent({
      userId,
      eventType: 'consecutive_days',
      eventData: { days: 7 },
      pointsAwarded: 25
    });
  }
  
  if (consecutiveDays === 30) {
    await GamificationService.dispatchEvent({
      userId,
      eventType: 'consecutive_days',
      eventData: { days: 30 },
      pointsAwarded: 100
    });
  }

  // ===== 3. EVENTOS DE CATEGORIZACIÓN =====
  
  // 5 categorías diferentes en un día
  if (categoriesUsedToday.length === 5) {
    await GamificationService.dispatchEvent({
      userId,
      eventType: 'category_milestone',
      eventData: { milestone: '5_categories_day' },
      pointsAwarded: 10
    });
  }
  
  // Completar todas las categorías disponibles
  if (categoriesUsedToday.length === totalCategories) {
    await GamificationService.dispatchEvent({
      userId,
      eventType: 'category_milestone',
      eventData: { milestone: 'all_categories' },
      pointsAwarded: 30
    });
  }
  
  // Especialista en categoría (20 transacciones en misma categoría)
  const categoryCount = await prisma.transaction.count({
    where: { userId, category_id: transaction.category_id }
  });
  
  if (categoryCount === 20) {
    await GamificationService.dispatchEvent({
      userId,
      eventType: 'category_milestone',
      eventData: { milestone: 'category_specialist', categoryId: transaction.category_id },
      pointsAwarded: 15
    });
  }

  // ===== 5. EVENTOS DE METAS FINANCIERAS =====
  
  // Primer ingreso del mes
  if (transaction.type === 'INCOME' && monthlyFirstIncome?.id === transaction.id) {
    await GamificationService.dispatchEvent({
      userId,
      eventType: 'add_tx',
      eventData: { milestone: 'first_income_month' },
      pointsAwarded: 10
    });
  }
  
  // Más ingresos que gastos en una semana (verificar al final de la semana)
  const weeklyIncome = await prisma.transaction.aggregate({
    where: { 
      userId, 
      type: 'INCOME',
      date: { gte: new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000) }
    },
    _sum: { amount: true }
  });
  
  const weeklyExpenses = await prisma.transaction.aggregate({
    where: { 
      userId, 
      type: 'EXPENSE',
      date: { gte: new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000) }
    },
    _sum: { amount: true }
  });
  
  if ((weeklyIncome._sum.amount || 0) > (weeklyExpenses._sum.amount || 0)) {
    await GamificationService.dispatchEvent({
      userId,
      eventType: 'add_tx',
      eventData: { milestone: 'positive_week' },
      pointsAwarded: 20
    });
  }
}

// Función auxiliar para calcular días consecutivos
// Optimizado: 1 query en lugar de hasta 30
async function calculateConsecutiveDays(userId: string): Promise<number> {
  const today = new Date();
  const thirtyDaysAgo = new Date(today);
  thirtyDaysAgo.setDate(today.getDate() - 30);

  // Una sola query: obtener fechas únicas con transacciones en los últimos 30 días
  const transactions = await prisma.transaction.findMany({
    where: {
      userId,
      date: { gte: thirtyDaysAgo }
    },
    select: { date: true },
    orderBy: { date: 'desc' }
  });

  if (transactions.length === 0) {
    return 0;
  }

  // Crear Set de fechas (solo año-mes-día) que tienen transacciones
  const datesWithTransactions = new Set<string>();
  for (const tx of transactions) {
    const dateKey = `${tx.date.getFullYear()}-${tx.date.getMonth()}-${tx.date.getDate()}`;
    datesWithTransactions.add(dateKey);
  }

  // Contar días consecutivos hacia atrás desde hoy
  let consecutiveDays = 0;

  for (let i = 0; i < 30; i++) {
    const checkDate = new Date(today);
    checkDate.setDate(today.getDate() - i);
    const dateKey = `${checkDate.getFullYear()}-${checkDate.getMonth()}-${checkDate.getDate()}`;

    if (datesWithTransactions.has(dateKey)) {
      consecutiveDays++;
    } else {
      break; // Mantiene la lógica original: se detiene en el primer día sin transacciones
    }
  }

  return consecutiveDays;
}

// Función utilitaria para recalcular el gasto de los presupuestos afectados
// Optimizado: reduce de 2N queries a 2 queries (1 findMany + 1 transacción batch)
// Exportada para uso en otros controladores (ej: Zenio)
export async function recalculateBudgetSpent(userId: string, categoryId: string, date: Date) {
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

  if (budgets.length === 0) {
    return;
  }

  // Encontrar el rango de fechas más amplio que cubra todos los presupuestos
  const minStartDate = budgets.reduce((min, b) =>
    b.start_date < min ? b.start_date : min, budgets[0].start_date);
  const maxEndDate = budgets.reduce((max, b) =>
    b.end_date > max ? b.end_date : max, budgets[0].end_date);

  // Una sola query para obtener todas las transacciones relevantes
  const transactions = await prisma.transaction.findMany({
    where: {
      userId,
      category_id: categoryId,
      type: 'EXPENSE',
      date: {
        gte: minStartDate,
        lte: maxEndDate
      }
    },
    select: { amount: true, date: true }
  });

  // Calcular el gasto para cada presupuesto en memoria
  const updates = budgets.map(budget => {
    const spent = transactions
      .filter(tx => tx.date >= budget.start_date && tx.date <= budget.end_date)
      .reduce((sum, tx) => sum + Number(tx.amount), 0);

    return prisma.budget.update({
      where: { id: budget.id },
      data: { spent }
    });
  });

  // Ejecutar todas las actualizaciones en una transacción atómica
  await prisma.$transaction(updates);
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
    const { page, limit, type, category_id, startDate, endDate } = req.query;

    // Sanitizar paginación con límite máximo de 100
    const pageNum = sanitizePage(page as string);
    const limitNum = sanitizeLimit(limit as string, PAGINATION.MAX_LIMITS.TRANSACTIONS);
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
    logger.error('Get transactions error:', error);
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
    logger.error('Get transaction by ID error:', error);
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

      // Verificar y enviar alertas de presupuesto
      try {
        await NotificationService.checkBudgetAlerts(userId, category_id, amount, transaction.date);
      } catch (error) {
        logger.error('Error checking budget alerts:', error);
      }
    }

    // Analizar y disparar eventos de gamificación inteligentes
    try {
      await analyzeAndDispatchTransactionEvents(userId, transaction);
    } catch (error) {
      logger.error('Error dispatching gamification events:', error);
      // No fallar la transacción por error de gamificación
    }

    return res.status(201).json({
      message: 'Transaction created successfully',
      transaction
    });
  } catch (error) {
    logger.error('Create transaction error:', error);
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

    // ============================================
    // SISTEMA DE APRENDIZAJE: Guardar mapeo si cambió la categoría
    // ============================================
    if (updateData.category_id && existingTransaction.category_id !== updateData.category_id) {
      // La descripción suele contener el nombre del comercio
      const merchantName = existingTransaction.description || transaction.description;

      if (merchantName && merchantName.trim().length > 2) {
        try {
          await merchantMappingService.saveMapping({
            userId,
            merchantName: merchantName.trim(),
            categoryId: updateData.category_id,
            source: MappingSource.USER_CORRECTION
          });

          logger.log(`[Transactions] Mapeo guardado: "${merchantName}" -> categoría ${updateData.category_id}`);
        } catch (error) {
          logger.error('[Transactions] Error guardando mapeo:', error);
          // No fallar la transacción por error de mapeo
        }
      }
    }

    return res.json({
      message: 'Transaction updated successfully',
      transaction
    });
  } catch (error) {
    logger.error('Update transaction error:', error);
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

    // Restar puntos de gamificación por eliminar transacción
    try {
      await GamificationService.dispatchEvent({
        userId,
        eventType: 'add_tx',
        eventData: {
          transactionId: existingTransaction.id,
          amount: existingTransaction.amount,
          type: existingTransaction.type,
          categoryId: existingTransaction.category_id,
          action: 'delete'
        },
        pointsAwarded: -5 // Restar 5 puntos
      });
    } catch (error) {
      logger.error('Error dispatching gamification event for delete:', error);
      // No fallar la eliminación por error de gamificación
    }

    return res.json({
      message: 'Transaction deleted successfully'
    });
  } catch (error) {
    logger.error('Delete transaction error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to delete transaction'
    });
  }
}; 