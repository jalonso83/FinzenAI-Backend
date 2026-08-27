import { Request, Response } from 'express';
import { MappingSource, RecurrenceFrequency } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { GamificationService } from '../services/gamificationService';
import { NotificationService } from '../services/notificationService';
import { merchantMappingService } from '../services/merchantMappingService';
import { recalculateBudgets } from '../services/budgetService';
import { recordFeatureUsage } from '../lib/featureUsage';
import { sanitizeLimit, sanitizePage, PAGINATION } from '../config/pagination';
import { onValidTransaction as onValidTransactionH13 } from '../services/h13/h13Service';
import { VALID_FREQUENCIES, isValidFrequency } from '../config/recurringConfig';

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

/**
 * Recalcula el acumulado de los presupuestos afectados. Se mantiene exportada
 * porque la usan varios controladores, pero la lógica vive ahora en
 * services/budgetService.ts — ver ahí la explicación de por qué se unificó.
 *
 * Esta variante NO notifica: es la que corresponde cuando el cambio no viene de
 * un movimiento nuevo del usuario (editar un presupuesto, borrar una
 * transacción). Para el alta de una transacción usa `recalculateBudgets(...,
 * { notify: true })` del servicio, que además dispara las alertas de umbral.
 */
export async function recalculateBudgetSpent(userId: string, categoryId: string, date: Date) {
  await recalculateBudgets(userId, categoryId, date, { notify: false });
}

// ─────────────────────────────────────────────────────────────────────────
// NÚCLEO COMPARTIDO DE CREACIÓN DE TRANSACCIONES
//
// Toda transacción, venga de donde venga (el usuario desde la app, o el cron
// de recurrentes), tiene que pasar por aquí. Antes esta lógica vivía inline
// dentro del handler HTTP `createTransaction`, así que cualquier otro camino
// que hiciera `prisma.transaction.create()` por su cuenta se saltaba en
// silencio el recálculo del `spent` de los presupuestos, las alertas y la
// gamificación — el dinero aparecía en la lista pero el presupuesto seguía
// diciendo que no habías gastado.
//
// `engagementHooks` distingue los dos casos de uso:
//   - true  (default, usuario real): dispara gamificación + hook de H13.
//   - false (cron de recurrentes): NO los dispara. Son señales de actividad
//     del usuario — darle racha y FinScore por un pago que registró un cron
//     mientras dormía inflaría el score y rompería el significado de la racha.
//   El impacto financiero (presupuesto, alertas, reportes) SÍ ocurre siempre.
// ─────────────────────────────────────────────────────────────────────────
export interface CreateTransactionCoreInput {
  userId: string;
  amount: number;
  type: 'INCOME' | 'EXPENSE';
  category_id: string;
  description?: string | null;
  date?: Date;
  recurringId?: string | null;
  engagementHooks?: boolean;
}

export async function createTransactionCore(
  input: CreateTransactionCoreInput
): Promise<{ transaction: any; h13Insight?: string }> {
  const {
    userId,
    amount,
    type,
    category_id,
    description,
    date,
    recurringId = null,
    engagementHooks = true,
  } = input;

  const transaction = await prisma.transaction.create({
    data: {
      userId,
      amount,
      type,
      category_id,
      description,
      date: date ?? new Date(),
      recurringId,
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

  // Recalcular el presupuesto de la categoría, y notificar si cruza un umbral.
  //
  // OJO: antes esto estaba dentro de `if (type === 'EXPENSE')`. Ya no puede ser:
  // existen presupuestos de INGRESO, y una transacción de ingreso tiene que
  // actualizar el suyo. El servicio se encarga de sumar solo las transacciones
  // del tipo que corresponda y de no mandar alertas de umbral en los de ingreso.
  //
  // El recálculo y las alertas van juntos en una sola llamada a propósito: antes
  // eran dos, y hubo caminos (los agentes de Zenio) que llamaban a uno y
  // olvidaban el otro, dejando presupuestos que se actualizaban sin avisar nunca.
  await recalculateBudgets(userId, category_id, transaction.date, { notify: true });

  if (!engagementHooks) {
    return { transaction };
  }

  // Analizar y disparar eventos de gamificación inteligentes
  try {
    await analyzeAndDispatchTransactionEvents(userId, transaction);
  } catch (error) {
    logger.error('Error dispatching gamification events:', error);
    // No fallar la transacción por error de gamificación
  }

  // H13 · Reto de la Primera Semana: asignar brazo en la 1ª TX válida y, si el reto
  // está en curso, obtener el micro-insight para mostrarlo (best-effort).
  let h13Insight: string | undefined;
  try {
    const r = await onValidTransactionH13(userId, transaction.id);
    h13Insight = r?.insight;
  } catch (error) {
    logger.error('Error en hook H13:', error);
  }

  return { transaction, h13Insight };
}

// Tipos para las peticiones
interface CreateTransactionRequest {
  amount: number;
  type: 'INCOME' | 'EXPENSE';
  category_id: string;
  description?: string;
  date?: string;
  // La frecuencia se tipa desde el enum de Prisma, no como unión literal, para
  // que agregar una frecuencia al schema no deje este tipo desactualizado.
  recurrence?: { frequency: RecurrenceFrequency } | null;
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

    // Honramos el límite que pide el cliente, SIN tope artificial. El dashboard y
    // la lista necesitan TODAS las transacciones del usuario para sumar el balance
    // correctamente (antes el cap de 100 truncaba y el balance "bailaba" según qué
    // 100 entraban). La query ya está acotada por `userId`, así que el máximo real
    // es la cantidad de transacciones del propio usuario — dinámico, no un número fijo.
    const pageNum = sanitizePage(page as string);
    const requestedLimit = parseInt(limit as string, 10);
    const limitNum = Number.isFinite(requestedLimit) && requestedLimit > 0
      ? requestedLimit
      : PAGINATION.DEFAULT_LIMIT;
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
        // Desempate estable: muchas transacciones comparten el mismo `date`
        // (mediodía). Sin desempate, el orden es no-determinístico y el corte
        // por paginación variaba entre cargas. createdAt + id lo fijan.
        orderBy: [{ date: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
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
    const { amount, type, category_id, description, date, recurrence }: CreateTransactionRequest = req.body;

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

    if (recurrence && !isValidFrequency(recurrence.frequency)) {
      return res.status(400).json({
        error: 'Validation error',
        message: `Recurrence frequency must be one of: ${VALID_FREQUENCIES.join(', ')}`
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

    const { transaction, h13Insight } = await createTransactionCore({
      userId,
      amount,
      type,
      category_id,
      description,
      date: date ? new Date(date) : new Date(),
    });

    // Si el usuario marcó "repetir automáticamente", además de la transacción de
    // hoy queda la regla. La primera ocurrencia generada es la SIGUIENTE — la de
    // hoy es esta misma, que acabamos de crear.
    // Best-effort a propósito: si falla la regla, la transacción ya quedó
    // registrada y no tiene sentido devolverle un error al usuario por eso.
    let recurringRule = null;
    if (recurrence) {
      try {
        // Import dinámico a propósito: recurringTransactionService importa
        // `createTransactionCore` de este mismo archivo. Un import estático de
        // vuelta cerraría el ciclo y, en CommonJS, uno de los dos módulos vería
        // al otro a medio inicializar. Mismo patrón que ya usa zenioV2.ts.
        const { createRecurringRule } = await import('../services/recurringTransactionService');
        recurringRule = await createRecurringRule({
          userId,
          amount,
          type,
          category_id,
          description,
          frequency: recurrence.frequency,
          startDate: transaction.date,
        });

        // Vincular la transacción que originó la regla. Sin esto, la app no le
        // pone el badge 🔄 ni le muestra "Dejar de repetir": el usuario que
        // acaba de activar la repetición abre justo ESA transacción para
        // cancelarla y no encuentra el botón.
        await prisma.transaction.update({
          where: { id: transaction.id },
          data: { recurringId: recurringRule.id },
        });
        transaction.recurringId = recurringRule.id;
      } catch (error) {
        logger.error('Error creando regla de recurrencia:', error);
      }
    }

    return res.status(201).json({
      message: 'Transaction created successfully',
      transaction,
      ...(recurringRule ? { recurring: recurringRule } : {}),
      ...(h13Insight ? { h13Insight } : {}),
    });
  } catch (error) {
    logger.error('Create transaction error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to create transaction'
    });
  }
};

/**
 * Nombre del comercio, limpio, sacado de la descripción de una importación.
 *
 * El banco arma la descripción así:
 *   "TOTAL MONUMENTAL SANTIAGO DOM - (****5107) - Auth: 427950 - [Importado de Email]"
 *
 * Todo lo que va después de " - (" cambia en cada compra: la tarjeta usada y,
 * sobre todo, el `Auth:`, que es distinto SIEMPRE. Por eso comparar la
 * descripción entera no sirve para agrupar por comercio.
 */
function nombreDeComercio(descripcion: string): string {
  return (descripcion.split(' - (')[0] || descripcion).trim();
}

/**
 * Prefijo con el que se buscan las demás compras del mismo comercio.
 *
 * No basta con el nombre completo: el banco lo trunca distinto según el canal
 * ("SANTIAGO DOM" en una, "SANTIAGO DO" en otra), así que dos compras del mismo
 * sitio no coinciden letra por letra. Se usan las primeras palabras, que es la
 * parte que sí se mantiene estable.
 *
 * Devuelve null si lo que queda es demasiado corto o genérico para arriesgarse
 * a agrupar — vale más no ofrecer la corrección que mezclar dos comercios.
 */
function prefijoDeComercio(descripcion: string): string | null {
  const comercio = nombreDeComercio(descripcion);
  if (comercio.length < 4) return null;

  const palabras = comercio.split(/\s+/).filter(Boolean);
  let prefijo = palabras.slice(0, 2).join(' ');

  // "1 2 TIEMPO BAR" empieza con dos palabras de una letra: con dos no alcanza
  // para identificar nada, así que se estira hasta tener algo con cuerpo.
  let n = 3;
  while (prefijo.length < 8 && n <= palabras.length) {
    prefijo = palabras.slice(0, n).join(' ');
    n++;
  }

  return prefijo.length >= 4 ? prefijo : null;
}

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

    // Recalcular los presupuestos afectados por la edición, de gasto o de ingreso.
    //
    // Son DOS recálculos porque la edición pudo mover la transacción de categoría
    // o de fecha: hay que descontarla de donde estaba y sumarla donde quedó. El
    // filtro por 'EXPENSE' que había aquí dejaba los presupuestos de INGRESO sin
    // actualizar al editar el monto o la fecha de un ingreso.
    await recalculateBudgetSpent(userId, existingTransaction.category_id, existingTransaction.date);

    // El segundo solo si de verdad cambió algo: si la categoría y la fecha son las
    // mismas, la llamada anterior ya cubrió ese presupuesto.
    if (
      transaction.category_id !== existingTransaction.category_id ||
      transaction.date.getTime() !== existingTransaction.date.getTime()
    ) {
      await recalculateBudgetSpent(userId, transaction.category_id, transaction.date);
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

    // ¿Hay más transacciones del MISMO comercio con la categoría vieja?
    //
    // El aprendizaje de arriba solo arregla el futuro. Con la primera revisión
    // del correo trayendo 90 días de golpe, una categoría mal puesta significa
    // que el usuario ve el mismo error repetido 8 veces y tiene que corregirlo
    // 8 veces. Ese es el momento en que la función deja de parecer mágica.
    //
    // Aquí solo se CUENTAN y se le devuelven a la app para que pregunte. No se
    // tocan solas: cambiarle 8 transacciones sin avisar es peor que dejarlas.
    let similares: { cantidad: number; comercio: string; prefijo: string } | null = null;
    if (updateData.category_id && existingTransaction.category_id !== updateData.category_id) {
      const prefijo = prefijoDeComercio(existingTransaction.description || '');

      if (prefijo) {
        const cantidad = await prisma.transaction.count({
          where: {
            userId,
            id: { not: transaction.id },
            description: { startsWith: prefijo },
            category_id: existingTransaction.category_id,
          },
        }).catch(() => 0);

        if (cantidad > 0) {
          similares = { cantidad, comercio: nombreDeComercio(existingTransaction.description || ''), prefijo };
        }
      }
    }

    return res.json({
      message: 'Transaction updated successfully',
      transaction,
      similares,
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

    // Recalcular el presupuesto de la categoría, sea de gasto o de ingreso.
    //
    // OJO: antes esto estaba dentro de `if (type === 'EXPENSE')`, igual que en el
    // alta. Con presupuestos de INGRESO eso dejaba el `spent` inflado para
    // siempre: borrabas el ingreso y el presupuesto seguía marcando el monto
    // viejo. El servicio ya filtra por el tipo que le toca a cada presupuesto,
    // así que llamarlo siempre es correcto para ambos tipos.
    await recalculateBudgetSpent(userId, existingTransaction.category_id, existingTransaction.date);

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
/**
 * POST /api/transactions/aplicar-categoria-comercio
 *
 * Aplica una categoría a TODAS las transacciones ya registradas de un comercio.
 *
 * Existe por lo que pasa la primera vez que alguien conecta su correo: entran
 * 90 días de golpe y, si un comercio quedó mal categorizado, el error aparece
 * repetido ocho veces. Sin esto el usuario tiene que corregir ocho veces lo
 * mismo — y ese es justo el momento en que la función deja de parecer mágica y
 * empieza a parecer trabajo.
 *
 * Se dispara solo cuando el usuario dice que sí; el update normal se limita a
 * contarlas y ofrecerlo.
 */
export const aplicarCategoriaAComercio = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { comercio, prefijo, categoriaAnterior, categoriaNueva } = req.body as {
      comercio?: string;
      prefijo?: string;
      categoriaAnterior?: string;
      categoriaNueva?: string;
    };

    if (!comercio || !categoriaNueva) {
      return res.status(400).json({ message: 'Falta comercio o categoriaNueva' });
    }

    const nombre = comercio.trim();
    if (nombre.length < 3) {
      return res.status(400).json({ message: 'Nombre de comercio demasiado corto' });
    }

    // Se busca por el MISMO prefijo con el que se contaron, no por el nombre
    // completo: si aquí se usara otro criterio, el número que vio el usuario y
    // el que se actualiza no coincidirían. El del cliente se ignora si no
    // cuadra con lo que sale del nombre — no se deja elegir el filtro desde
    // fuera, que sería una forma de recategorizar transacciones ajenas al
    // comercio que se está corrigiendo.
    const prefijoCalculado = prefijoDeComercio(nombre) || nombre;
    const filtro = prefijo && prefijoCalculado.startsWith(prefijo.trim())
      ? prefijo.trim()
      : prefijoCalculado;

    // La categoría destino tiene que existir y ser real. El `isDefault: true`
    // no es decorativo: la categoría "cancelada" está marcada con `false` y
    // mandar transacciones ahí las sacaría de todos los cálculos.
    const categoria = await prisma.category.findFirst({
      where: { id: categoriaNueva, isDefault: true },
    });
    if (!categoria) {
      return res.status(400).json({ message: 'Categoría inválida' });
    }

    // Solo las de ESTE usuario, con ESE texto y —si viene— la categoría vieja.
    // El filtro por categoría anterior evita pisar transacciones que el usuario
    // ya había clasificado a mano de otra forma.
    const objetivo = await prisma.transaction.findMany({
      where: {
        userId,
        description: { startsWith: filtro },
        ...(categoriaAnterior ? { category_id: categoriaAnterior } : {}),
        category_id: { not: categoriaNueva },
      },
      select: { id: true, category_id: true, date: true },
    });

    if (objetivo.length === 0) {
      return res.json({ actualizadas: 0 });
    }

    await prisma.transaction.updateMany({
      where: { id: { in: objetivo.map((t) => t.id) } },
      data: { category_id: categoriaNueva },
    });

    // Recalcular presupuestos de AMBOS lados y de cada período tocado: las
    // transacciones pueden abarcar meses distintos, así que no basta con
    // recalcular una vez. Se deduplica por categoría+mes para no repetir.
    const vistos = new Set<string>();
    for (const t of objetivo) {
      for (const cat of [t.category_id, categoriaNueva]) {
        const clave = `${cat}|${t.date.getUTCFullYear()}-${t.date.getUTCMonth()}`;
        if (vistos.has(clave)) continue;
        vistos.add(clave);
        await recalculateBudgetSpent(userId, cat, t.date).catch(() => {});
      }
    }

    // El mapeo ya se guardó en el update que disparó esto, pero se refuerza:
    // que el usuario acepte arreglar 8 es una señal más fuerte que corregir 1.
    try {
      await merchantMappingService.saveMapping({
        userId,
        merchantName: nombre,
        categoryId: categoriaNueva,
        source: MappingSource.USER_CORRECTION,
      });
    } catch { /* el mapeo es best-effort, la corrección ya se aplicó */ }

    recordFeatureUsage(userId, 'email_sync', 'corrigio_comercio', {
      transacciones: objetivo.length,
    });

    logger.log(`[Transactions] "${nombre}" recategorizado en ${objetivo.length} transacciones de ${userId}`);

    return res.json({ actualizadas: objetivo.length });
  } catch (error) {
    logger.error('Error aplicando categoría a comercio:', error);
    return res.status(500).json({ message: 'No se pudo aplicar la categoría' });
  }
};
