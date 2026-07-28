import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { nextOccurrence, localToday } from '../services/recurringTransactionService';
import { logger } from '../utils/logger';

// ─────────────────────────────────────────────────────────────────────────
// Reglas de gastos/ingresos recurrentes.
//
// La app las gestiona desde dos lugares (pedido del socio): la vista de "Pagos
// automáticos" dentro de Transacciones, y la edición de una transacción
// generada por una regla. Ambos pegan a estos mismos endpoints.
//
// Todas las operaciones filtran por userId además del id: sin eso, cualquier
// usuario autenticado podría apagar o borrar las reglas de otro (IDOR).
// ─────────────────────────────────────────────────────────────────────────

const CATEGORY_SELECT = {
  select: { id: true, name: true, icon: true, type: true },
};

/** GET / — todas las reglas del usuario, activas e inactivas. */
export const getRecurringTransactions = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;

    const rules = await prisma.recurringTransaction.findMany({
      where: { userId },
      include: { category: CATEGORY_SELECT },
      orderBy: [{ isActive: 'desc' }, { nextRunDate: 'asc' }],
    });

    return res.json({ recurringTransactions: rules });
  } catch (error) {
    logger.error('Get recurring transactions error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to fetch recurring transactions',
    });
  }
};

/**
 * PATCH /:id/toggle — apaga o prende una regla.
 *
 * Al PRENDER se recalcula `nextRunDate` desde hoy a propósito: si se dejara la
 * fecha vieja, reactivar una regla apagada hace tres meses dispararía de golpe
 * el catch-up de todas las ocurrencias de esos tres meses. Apagar es apagar:
 * ese período no se cobra retroactivamente.
 */
export const toggleRecurringTransaction = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;
    const { isActive } = req.body as { isActive?: boolean };

    const rule = await prisma.recurringTransaction.findFirst({
      where: { id, userId },
      include: { user: { select: { country: true } } },
    });

    if (!rule) {
      return res.status(404).json({
        error: 'Not found',
        message: 'Recurring transaction not found',
      });
    }

    // Si no viene `isActive` en el body, es un toggle simple.
    const nextActive = typeof isActive === 'boolean' ? isActive : !rule.isActive;

    const data: { isActive: boolean; nextRunDate?: Date } = { isActive: nextActive };
    if (nextActive && !rule.isActive) {
      // El día local del USUARIO, no el del server. Reactivando a las 9 PM en
      // RD ya es el día siguiente en UTC, y la próxima ejecución saldría
      // corrida un día respecto a lo que el usuario ve en pantalla.
      data.nextRunDate = nextOccurrence(rule.frequency, rule.startDate, localToday(rule.user.country));
    }

    const updated = await prisma.recurringTransaction.update({
      where: { id: rule.id },
      data,
      include: { category: CATEGORY_SELECT },
    });

    return res.json({
      message: nextActive ? 'Recurring transaction activated' : 'Recurring transaction paused',
      recurringTransaction: updated,
    });
  } catch (error) {
    logger.error('Toggle recurring transaction error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to toggle recurring transaction',
    });
  }
};

/**
 * DELETE /:id — elimina la regla.
 *
 * Las transacciones que ya generó NO se borran: son movimientos reales que ya
 * impactaron presupuestos y reportes. La relación es onDelete: SetNull, así que
 * quedan como transacciones normales sin el badge de recurrente.
 */
export const deleteRecurringTransaction = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;

    const rule = await prisma.recurringTransaction.findFirst({
      where: { id, userId },
    });

    if (!rule) {
      return res.status(404).json({
        error: 'Not found',
        message: 'Recurring transaction not found',
      });
    }

    await prisma.recurringTransaction.delete({ where: { id: rule.id } });

    return res.json({ message: 'Recurring transaction deleted successfully' });
  } catch (error) {
    logger.error('Delete recurring transaction error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to delete recurring transaction',
    });
  }
};
