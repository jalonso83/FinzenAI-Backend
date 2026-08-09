import { BudgetType } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { logger } from '../utils/logger';
import { NotificationService } from './notificationService';
import { subscriptionService } from './subscriptionService';
import { PLANS } from '../config/stripe';

/**
 * Recálculo del acumulado de los presupuestos afectados por un movimiento, y las
 * alertas de umbral que eso dispare.
 *
 * ─── Por qué existe este servicio (unificación, 2026-08-09) ───────────────────
 *
 * Antes había DOS implementaciones paralelas del mismo cálculo:
 *
 *   A) `recalculateBudgetSpent` en controllers/transactions.ts — actualizaba
 *      `spent` pero NO notificaba. Quien la llamaba tenía que acordarse de
 *      invocar además `NotificationService.checkBudgetAlerts`.
 *   B) Una copia privada en services/emailSyncService.ts que hacía las dos cosas
 *      juntas, con su propia lógica de umbrales.
 *
 * Diferencias reales entre ambas, no cosméticas:
 *
 *   1. Cómo obtenían el valor ANTERIOR. `checkBudgetAlerts` lo INFERÍA restando
 *      el monto de la transacción (`previousSpent = spent - transactionAmount`),
 *      lo cual solo es correcto si esa transacción fue el único motivo del
 *      cambio. Con ediciones, borrados o varias transacciones seguidas el número
 *      salía mal y la alerta se disparaba —o se perdía— sin razón. La copia de
 *      email sync leía el valor real antes de actualizar. Aquí se hace lo
 *      segundo, que es lo correcto.
 *   2. El límite de plan (las alertas de umbral son de Plus y Pro) vivía solo en
 *      `checkBudgetAlerts`. Ahora vive aquí, en el único camino.
 *
 * Y el bug que provocó la separación: `zenioAgents.ts` llamaba al recálculo pero
 * NUNCA a `checkBudgetAlerts`, así que registrar un gasto por los agentes de
 * Zenio actualizaba el presupuesto sin avisar jamás del umbral. Con una sola
 * función que hace ambas cosas, ese olvido deja de ser posible.
 *
 * ─── Presupuestos de ingreso ──────────────────────────────────────────────────
 *
 * Un presupuesto EXPENSE es un techo y uno INCOME es un piso, así que el
 * acumulado se suma con transacciones del tipo que corresponda. Las alertas de
 * umbral SOLO aplican a EXPENSE: avisarle a alguien que "va por el 80%" de lo
 * que espera facturar sería felicitarlo con cara de advertencia. El aviso de
 * ingresos (ir corto al cierre del período) es otro momento de disparo y vive en
 * su propio scheduler, no aquí.
 */

interface RecalcOptions {
  /** Emitir alertas de umbral. `false` al crear/editar un presupuesto o al
   *  borrar transacciones: ahí el cambio no es un movimiento del usuario. */
  notify?: boolean;
}

export async function recalculateBudgets(
  userId: string,
  categoryId: string,
  date: Date,
  options: RecalcOptions = {},
): Promise<void> {
  const { notify = false } = options;

  try {
    // Presupuestos activos de esa categoría cuyo período incluya la fecha.
    const budgets = await prisma.budget.findMany({
      where: {
        user_id: userId,
        category_id: categoryId,
        is_active: true,
        start_date: { lte: date },
        end_date: { gte: date },
      },
      include: { user: { select: { currency: true } } },
    });

    if (budgets.length === 0) return;

    // Rango que cubre a todos, para traer las transacciones en UNA consulta.
    const minStart = budgets.reduce((min, b) => (b.start_date < min ? b.start_date : min), budgets[0].start_date);
    const maxEnd = budgets.reduce((max, b) => (b.end_date > max ? b.end_date : max), budgets[0].end_date);

    // Un presupuesto de gasto se nutre de transacciones EXPENSE y uno de ingreso
    // de INCOME. Como en la misma categoría solo puede haber presupuestos de un
    // tipo (la categoría ya es de gastos o de ingresos), basta con mirar los
    // tipos presentes y traer solo esos.
    const tiposNecesarios = Array.from(new Set(budgets.map((b) => b.type)));

    const transactions = await prisma.transaction.findMany({
      where: {
        userId,
        category_id: categoryId,
        type: { in: tiposNecesarios },
        date: { gte: minStart, lte: maxEnd },
      },
      select: { amount: true, date: true, type: true },
    });

    // ¿Puede alertar? El plan se consulta UNA vez y solo si hace falta.
    let puedeAlertar = false;
    if (notify) {
      try {
        const subscription = await subscriptionService.getUserSubscription(userId);
        const planLimits = subscription.limits as { budgetAlerts?: boolean };
        puedeAlertar = planLimits.budgetAlerts ?? PLANS.FREE.limits.budgetAlerts;
      } catch (error) {
        logger.error('[BudgetService] No se pudo leer el plan; no se alerta:', error);
      }
    }

    for (const budget of budgets) {
      const anterior = Number(budget.spent) || 0;

      const acumulado = transactions
        .filter((t) => t.type === budget.type && t.date >= budget.start_date && t.date <= budget.end_date)
        .reduce((sum, t) => sum + Number(t.amount), 0);

      // Escribir solo si cambió: evita updates inútiles y toques de updated_at.
      if (acumulado !== anterior) {
        await prisma.budget.update({ where: { id: budget.id }, data: { spent: acumulado } });
      }

      // Las alertas de umbral son exclusivas de los presupuestos de GASTO.
      if (!notify || !puedeAlertar || budget.type !== BudgetType.EXPENSE) continue;

      const monto = Number(budget.amount);
      if (!(monto > 0)) continue; // presupuesto en 0 → todo porcentaje sería infinito

      const umbral = Number(budget.alert_percentage) || 80;
      const currency = budget.user?.currency || 'RD$';
      const pctAntes = (anterior / monto) * 100;
      const pctAhora = (acumulado / monto) * 100;

      try {
        // Cruce del umbral de aviso (sin haber llegado todavía al 100%).
        if (pctAntes < umbral && pctAhora >= umbral && pctAhora < 100) {
          await NotificationService.notifyBudgetAlert(
            userId,
            budget.name,
            Math.round(pctAhora),
            monto - acumulado,
            currency,
          );
        }

        // Presupuesto excedido.
        if (pctAntes < 100 && pctAhora >= 100) {
          await NotificationService.notifyBudgetExceeded(
            userId,
            budget.name,
            acumulado - monto,
            currency,
          );
        }
      } catch (error) {
        // Notificar nunca debe romper el recálculo: el `spent` ya quedó bien.
        logger.error(`[BudgetService] Error notificando presupuesto ${budget.id}:`, error);
      }
    }
  } catch (error) {
    // Best-effort, igual que antes: un fallo aquí no debe tumbar la creación de
    // la transacción que lo disparó.
    logger.error('[BudgetService] Error recalculando presupuestos:', error);
  }
}

export default { recalculateBudgets };
