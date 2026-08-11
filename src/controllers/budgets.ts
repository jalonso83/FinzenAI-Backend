import { Request, Response } from 'express';
import { BudgetType } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { GamificationService } from '../services/gamificationService';
import { sanitizeLimit, sanitizePage, PAGINATION } from '../config/pagination';

import { logger } from '../utils/logger';
import { recalculateBudgetSpent } from './transactions';
import { crearPresupuestoSinSolapar, buscarPresupuestoSolapado, PresupuestoSolapadoError } from '../services/budgetService';
// Etiqueta en español del período, para los mensajes que ve el usuario.
// Antes se devolvía el valor crudo ('monthly') y la app lo mostraba tal cual.
const etiquetaPeriodo = (period: string): string => ({
  weekly: 'semanal',
  biweekly: 'quincenal',
  monthly: 'mensual',
  yearly: 'anual',
}[period] || period);

// Tipos para las peticiones
interface CreateBudgetRequest {
  name: string;
  category_id: string;
  amount: number;
  period: string; // 'weekly' | 'biweekly' | 'monthly' | 'yearly'
  start_date: string;
  end_date: string;
  alert_percentage?: number;
  description?: string;
  // EXPENSE (techo de gasto) | INCOME (lo que espera facturar en el período).
  // Opcional: si no viene, EXPENSE — así las apps viejas siguen funcionando.
  type?: BudgetType;
}

interface UpdateBudgetRequest {
  name?: string;
  category_id?: string;
  type?: BudgetType;
  description?: string;
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
    const { page, limit, is_active, category_id } = req.query;

    // Sanitizar paginación con límite máximo de 50
    const pageNum = sanitizePage(page as string);
    const limitNum = sanitizeLimit(limit as string, PAGINATION.MAX_LIMITS.BUDGETS);
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

    // Convertir Decimal a number para asegurar serialización correcta
    const serializedBudgets = budgets.map(budget => ({
      ...budget,
      amount: Number(budget.amount),
      spent: Number(budget.spent || 0),
      alert_percentage: budget.alert_percentage ? Number(budget.alert_percentage) : null
    }));

    return res.json({
      budgets: serializedBudgets,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum)
      }
    });
  } catch (error) {
    logger.error('Get budgets error:', error);
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

    // Serializar budget para asegurar números correctos
    const serializedBudget = {
      ...budget,
      amount: Number(budget.amount),
      spent: Number(budget.spent || 0),
      alert_percentage: budget.alert_percentage ? Number(budget.alert_percentage) : null
    };

    return res.json({ budget: serializedBudget });
  } catch (error) {
    logger.error('Get budget by ID error:', error);
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
      alert_percentage = 80,
      type = BudgetType.EXPENSE,
      description
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

    // 'biweekly' = quincenas del calendario (1-15 y 16-fin de mes), no "15 días".
    if (!['weekly', 'biweekly', 'monthly', 'yearly'].includes(period)) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'Period must be weekly, biweekly, monthly, or yearly'
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

    // El tipo del presupuesto DEBE coincidir con el de la categoría. Antes esto
    // no se validaba: el backend aceptaba una categoría de ingreso y creaba un
    // presupuesto que siempre mostraba 0, porque el recálculo solo sumaba
    // transacciones de gasto. La puerta estaba solo en la app.
    if (!['EXPENSE', 'INCOME'].includes(String(type))) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'Type must be EXPENSE or INCOME'
      });
    }

    if (category.type !== type) {
      return res.status(400).json({
        error: 'Validation error',
        message: type === BudgetType.INCOME
          ? `"${category.name}" es una categoría de gastos: no puedes usarla en un presupuesto de ingresos`
          : `"${category.name}" es una categoría de ingresos: no puedes usarla en un presupuesto de gastos`
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

    // La comprobación de solapamiento y el create van juntos y bajo lock dentro de
    // `crearPresupuestoSinSolapar`. Antes eran dos pasos sueltos: dos peticiones
    // simultáneas pasaban las dos por el findFirst sin encontrar nada y creaban
    // ambas. Ver la nota larga en services/budgetService.ts.
    let budget;
    try {
      budget = await crearPresupuestoSinSolapar({
        user_id: userId,
        name,
        category_id,
        amount,
        period,
        start_date: startDate,
        end_date: endDate,
        alert_percentage,
        type,
        description: description?.trim() || null
      });
    } catch (e) {
      if (e instanceof PresupuestoSolapadoError) {
        const existente = e.existente;
        return res.status(409).json({
          error: 'Duplicate budget',
          message: `Ya existe un presupuesto ${etiquetaPeriodo(existente.period)} activo para "${existente.category?.name}" en estas fechas`,
          existingBudget: {
            id: existente.id,
            name: existente.name,
            amount: Number(existente.amount),
            spent: Number(existente.spent || 0),
            period: existente.period,
            start_date: existente.start_date,
            end_date: existente.end_date,
            category: existente.category
          }
        });
      }
      throw e;
    }

    // Inicializar `spent` con las transacciones que YA existen en el período.
    // Sin esto, un presupuesto creado después de registrar gastos nace en 0 y
    // se queda así hasta la próxima transacción (bug: budget muestra 0 gastado).
    await recalculateBudgetSpent(userId, category_id, startDate);
    const refreshed = await prisma.budget.findUnique({ where: { id: budget.id }, select: { spent: true } });

    // Serializar budget antes de enviar
    const serializedBudget = {
      ...budget,
      amount: Number(budget.amount),
      spent: Number(refreshed?.spent ?? budget.spent ?? 0),
      alert_percentage: budget.alert_percentage ? Number(budget.alert_percentage) : null
    };

    // Disparar evento de gamificación
    try {
      await GamificationService.dispatchEvent({
        userId,
        eventType: 'create_budget',
        eventData: {
          budgetId: budget.id,
          amount: Number(budget.amount),
          period: budget.period,
          categoryId: budget.category_id
        },
        // 0 A PROPÓSITO: los puntos totales se calculan sumando `pointsAwarded`
        // de TODOS los eventos, y `handleBudgetCreated` ya crea su propia fila
        // de +20. Poniendo 20 aquí también, crear un presupuesto valía +40 y el
        // ciclo crear→borrar dejaba saldo positivo. Ahora crear suma 20 y
        // borrar resta 20, que se anulan.
        pointsAwarded: 0
      });
    } catch (error) {
      logger.error('Error dispatching gamification event:', error);
      // No fallar la creación del presupuesto por error de gamificación
    }

    return res.status(201).json({
      message: 'Budget created successfully',
      budget: serializedBudget
    });
  } catch (error) {
    logger.error('Create budget error:', error);
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

    if (updateData.period && !['weekly', 'biweekly', 'monthly', 'yearly'].includes(updateData.period)) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'Period must be weekly, biweekly, monthly, or yearly'
      });
    }

    if (updateData.alert_percentage !== undefined && (updateData.alert_percentage < 0 || updateData.alert_percentage > 100)) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'Alert percentage must be between 0 and 100'
      });
    }

    // Si cambia la categoría O el tipo, revalidar que sigan siendo coherentes.
    // Hay que mirar los dos juntos: cambiar solo el tipo sobre la categoría vieja
    // dejaría un presupuesto de ingresos apuntando a una categoría de gastos, que
    // nunca acumularía nada.
    if (updateData.category_id !== undefined || updateData.type !== undefined) {
      const categoryId = updateData.category_id ?? existingBudget.category_id;
      const tipo = updateData.type ?? existingBudget.type;

      if (!['EXPENSE', 'INCOME'].includes(String(tipo))) {
        return res.status(400).json({
          error: 'Validation error',
          message: 'Type must be EXPENSE or INCOME'
        });
      }

      const category = await prisma.category.findUnique({ where: { id: categoryId } });

      if (!category) {
        return res.status(400).json({
          error: 'Validation error',
          message: 'Category does not exist'
        });
      }

      if (category.type !== tipo) {
        return res.status(400).json({
          error: 'Validation error',
          message: tipo === BudgetType.INCOME
            ? `"${category.name}" es una categoría de gastos: no puedes usarla en un presupuesto de ingresos`
            : `"${category.name}" es una categoría de ingresos: no puedes usarla en un presupuesto de gastos`
        });
      }
    }

    // Preparar datos para actualización. WHITELIST explícita: NUNCA hacer
    // `{ ...updateData }` — eso permitiría que el cliente sobrescriba campos
    // controlados por el servidor como `spent` (mass-assignment). `spent` solo
    // se calcula vía recalculateBudgetSpent, jamás desde el body.
    const dataToUpdate: any = {};
    if (updateData.name !== undefined) dataToUpdate.name = updateData.name;
    if (updateData.category_id !== undefined) dataToUpdate.category_id = updateData.category_id;
    if (updateData.type !== undefined) dataToUpdate.type = updateData.type;
    if (updateData.description !== undefined) dataToUpdate.description = updateData.description?.trim() || null;
    if (updateData.amount !== undefined) dataToUpdate.amount = updateData.amount;
    if (updateData.period !== undefined) dataToUpdate.period = updateData.period;
    if (updateData.alert_percentage !== undefined) dataToUpdate.alert_percentage = updateData.alert_percentage;
    if (updateData.is_active !== undefined) dataToUpdate.is_active = updateData.is_active;

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

    // Editar también puede provocar un solapamiento: mover las fechas, cambiar de
    // categoría o reactivar un presupuesto viejo puede dejarlo encima de otro que
    // ya estaba activo. Se comprueba con los valores RESULTANTES (los nuevos si
    // vienen en la petición, los actuales si no) y excluyendo el propio.
    const resultante = {
      category_id: dataToUpdate.category_id ?? existingBudget.category_id,
      start_date: dataToUpdate.start_date ?? existingBudget.start_date,
      end_date: dataToUpdate.end_date ?? existingBudget.end_date,
      is_active: dataToUpdate.is_active ?? existingBudget.is_active,
    };

    // SOLO se comprueba si la petición toca de verdad la ventana: la categoría,
    // las fechas, o reactiva un presupuesto apagado. Comprobar en toda edición
    // sería un desastre: hay presupuestos solapados de antes en la base, y a
    // quien tenga uno le rebotaría cualquier cambio —el monto, el nombre— con un
    // 409 que además le echa la culpa a un cambio que no hizo. Editar el monto de
    // un presupuesto ya solapado tiene que seguir funcionando; lo que se impide
    // es CREAR solapamiento nuevo.
    // Se compara el VALOR, no la presencia de la clave: los tres formularios
    // (iOS, Android y web) mandan `category_id` y `is_active` en cada update
    // aunque no hayan cambiado, así que mirar solo si el campo viene haría que
    // esto se disparara siempre y volveríamos al 409 en toda edición.
    const mismaFecha = (a: any, b: any) => new Date(a).getTime() === new Date(b).getTime();
    const reactivando = dataToUpdate.is_active === true && !existingBudget.is_active;
    const tocaLaVentana =
      (dataToUpdate.category_id !== undefined && dataToUpdate.category_id !== existingBudget.category_id) ||
      (dataToUpdate.start_date !== undefined && !mismaFecha(dataToUpdate.start_date, existingBudget.start_date)) ||
      (dataToUpdate.end_date !== undefined && !mismaFecha(dataToUpdate.end_date, existingBudget.end_date)) ||
      reactivando;

    if (tocaLaVentana && resultante.is_active) {
      const solapado = await buscarPresupuestoSolapado(prisma, {
        user_id: userId,
        category_id: resultante.category_id,
        start_date: resultante.start_date,
        end_date: resultante.end_date,
        excluirId: id,
      });

      if (solapado) {
        return res.status(409).json({
          error: 'Duplicate budget',
          message: `Ese cambio dejaría dos presupuestos de "${solapado.category?.name}" activos en las mismas fechas. Ya tienes uno ${etiquetaPeriodo(solapado.period)}.`,
          existingBudget: {
            id: solapado.id,
            name: solapado.name,
            amount: Number(solapado.amount),
            spent: Number(solapado.spent || 0),
            period: solapado.period,
            start_date: solapado.start_date,
            end_date: solapado.end_date,
            category: solapado.category
          }
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

    // Recalcular `spent` tras el update: si cambiaron fechas o categoría, el
    // gasto del período pudo cambiar. Usamos una fecha dentro del período actual.
    await recalculateBudgetSpent(budget.user_id, budget.category_id, budget.start_date);
    const refreshed = await prisma.budget.findUnique({ where: { id: budget.id }, select: { spent: true } });

    // Serializar budget antes de enviar
    const serializedBudget = {
      ...budget,
      amount: Number(budget.amount),
      spent: Number(refreshed?.spent ?? budget.spent ?? 0),
      alert_percentage: budget.alert_percentage ? Number(budget.alert_percentage) : null
    };

    return res.json({
      message: 'Budget updated successfully',
      budget: serializedBudget
    });
  } catch (error) {
    logger.error('Update budget error:', error);
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

    // Restar puntos de gamificación por eliminar presupuesto
    try {
      await GamificationService.dispatchEvent({
        userId,
        // NO es 'create_budget'. dispatchEvent ignora `pointsAwarded` para la
        // lógica: entraba por el `case 'create_budget'` y sumaba +20 igual que
        // al crear. Resultado: crear y borrar en bucle daba +40 netos por
        // vuelta, BORRAR un presupuesto extendía la racha diaria y además
        // contaba para la insignia "Planificador".
        eventType: 'delete_budget',
        eventData: {
          budgetId: existingBudget.id,
          amount: existingBudget.amount,
          period: existingBudget.period,
          categoryId: existingBudget.category_id,
          action: 'delete'
        },
        pointsAwarded: -20 // Restar 20 puntos
      });
    } catch (error) {
      logger.error('Error dispatching gamification event for delete:', error);
      // No fallar la eliminación por error de gamificación
    }

    return res.json({
      message: 'Budget deleted successfully'
    });
  } catch (error) {
    logger.error('Delete budget error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to delete budget'
    });
  }
}; 