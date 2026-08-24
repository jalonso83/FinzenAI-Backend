import { BudgetType } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { logger } from '../utils/logger';
import { NotificationService } from './notificationService';
import { subscriptionService } from './subscriptionService';
import { PLANS } from '../config/stripe';
import { recordFeatureUsage } from '../lib/featureUsage';

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
          // Entrega REAL de una función de pago: las alertas de umbral son de
          // Plus y Pro (`budgetAlerts: false` en FREE). A diferencia de las
          // demás, esta el usuario no la pide — se la entregamos. Medirla dice
          // si el plan de pago está haciendo algo por él además de existir.
          recordFeatureUsage(userId, 'premium', 'alerta_umbral');

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

/**
 * ─── Guardia contra presupuestos duplicados y solapados (2026-08-10) ──────────
 *
 * Dos presupuestos activos de la misma categoría cuyas fechas se pisan es SIEMPRE
 * un error: `recalculateBudgets` (arriba) busca por rango de fechas, así que le
 * asigna LAS MISMAS transacciones a los dos, y el dashboard —que suma todos los
 * presupuestos activos— cuenta el gasto y el monto por partida doble.
 *
 * Antes esto se validaba en UN solo sitio (`controllers/budgets.ts`) de los SEIS
 * que crean presupuestos: los cinco de Zenio hacían `prisma.budget.create` a
 * pelo. Y la validación que había era un `findFirst` seguido de un `create`, dos
 * pasos sin transacción: dos peticiones simultáneas pasaban ambas por el
 * `findFirst`, ninguna encontraba nada, y las dos creaban.
 *
 * Por eso aquí no se valida "a mano": se toma un lock por (usuario, categoría)
 * dentro de la transacción, de modo que dos creaciones simultáneas de la misma
 * categoría se serializan y la segunda ya ve lo que insertó la primera. El lock
 * es de transacción (`_xact_`), se libera solo al hacer commit o rollback, y solo
 * bloquea a quien toque esa misma pareja usuario+categoría.
 */

export interface DatosPresupuesto {
  user_id: string;
  name: string;
  category_id: string;
  amount: number;
  period: string;
  start_date: Date;
  end_date: Date;
  alert_percentage?: number;
  type?: BudgetType;
  description?: string | null;
}

/** Error tipado para que cada llamador decida su formato de respuesta (409 en
 *  REST, mensaje conversacional en Zenio) sin repetir la consulta. */
export class PresupuestoSolapadoError extends Error {
  constructor(public readonly existente: any) {
    super('Ya existe un presupuesto activo que se solapa con este');
    this.name = 'PresupuestoSolapadoError';
  }
}

/** Presupuesto activo de la misma categoría cuyo período se cruce con [inicio, fin]. */
export async function buscarPresupuestoSolapado(
  cliente: any,
  params: {
    user_id: string;
    category_id: string;
    start_date: Date;
    end_date: Date;
    excluirId?: string;
    /** Limitar la búsqueda a presupuestos de ESTA recurrencia. Solo lo usa la
     *  renovación automática; ver el porqué en budgetRenewalService. Al crear NO
     *  se pasa: ahí cualquier solapamiento es dañino, coincida o no el período. */
    period?: string;
  },
) {
  const { user_id, category_id, start_date, end_date, excluirId, period } = params;
  return cliente.budget.findFirst({
    where: {
      user_id,
      category_id,
      is_active: true,
      ...(excluirId ? { id: { not: excluirId } } : {}),
      ...(period ? { period } : {}),
      // Dos rangos se solapan si cada uno empieza antes de que termine el otro.
      // Es la forma corta y equivalente a los tres casos que se enumeraban antes
      // (empieza dentro / termina dentro / lo contiene), sin dejar huecos.
      start_date: { lte: end_date },
      end_date: { gte: start_date },
    },
    include: { category: { select: { id: true, name: true, icon: true } } },
  });
}

/**
 * Crea un presupuesto garantizando que no se solape con otro activo de la misma
 * categoría. Lanza `PresupuestoSolapadoError` si lo hay. Úsala SIEMPRE en vez de
 * `prisma.budget.create` — es el único punto donde la exclusión está garantizada.
 */
export async function crearPresupuestoSinSolapar(datos: DatosPresupuesto) {
  return prisma.$transaction(async (tx) => {
    // Serializa a los que compiten por la misma (usuario, categoría). Sin esto,
    // dos peticiones a la vez comprueban en paralelo y las dos crean.
    //
    // OJO: tiene que ser `$executeRawUnsafe`, NO `$queryRawUnsafe`.
    // pg_advisory_xact_lock() devuelve `void` y Prisma revienta al intentar
    // deserializar esa columna ("Failed to deserialize column of type 'void'"),
    // lo que dejaría la creación de presupuestos rota por completo. `tsc` no lo
    // detecta porque el SQL es una cadena. Verificado contra Postgres real:
    // dos transacciones con la misma clave se serializan, y con claves
    // distintas siguen corriendo en paralelo.
    await tx.$executeRawUnsafe(
      'SELECT pg_advisory_xact_lock(hashtext($1)::bigint)',
      `budget:${datos.user_id}:${datos.category_id}`,
    );

    // Los campos van UNO A UNO, sin pasar `datos` entero: ese objeto lleva
    // `period`, y `buscarPresupuestoSolapado` lo interpreta como "busca solo
    // dentro de esta recurrencia". Pasándolo sin querer, crear un presupuesto
    // QUINCENAL solo se comparaba contra otros quincenales y no veía el MENSUAL
    // que ya cubría esas fechas — que es justo el solapamiento que hay que
    // impedir. Aquí no se filtra por período a propósito: cualquier solapamiento
    // es dañino, coincida o no la recurrencia. El único que sí debe pasarlo es
    // la renovación automática, y lo hace explícitamente.
    const existente = await buscarPresupuestoSolapado(tx, {
      user_id: datos.user_id,
      category_id: datos.category_id,
      start_date: datos.start_date,
      end_date: datos.end_date,
    });
    if (existente) throw new PresupuestoSolapadoError(existente);

    // El nombre nunca puede quedar vacío. Había dos presupuestos así en
    // producción y hacían daño de una forma nada evidente: el recordatorio
    // diario deduplicaba buscando si el título CONTENÍA el nombre, y una cadena
    // vacía coincide con todos los títulos, así que ese usuario tenía
    // silenciados los avisos de TODOS sus presupuestos. La deduplicación ya se
    // corrigió, pero con cinco caminos creando presupuestos el nombre no debe
    // depender de que el cliente lo mande bien.
    const categoria = await tx.category.findUnique({
      where: { id: datos.category_id },
      select: { name: true },
    });
    const nombre = datos.name?.trim() || categoria?.name || 'Presupuesto';

    return tx.budget.create({
      data: {
        user_id: datos.user_id,
        name: nombre,
        category_id: datos.category_id,
        amount: datos.amount,
        period: datos.period,
        start_date: datos.start_date,
        end_date: datos.end_date,
        alert_percentage: datos.alert_percentage ?? 80,
        type: datos.type ?? BudgetType.EXPENSE,
        description: datos.description ?? null,
      },
      // `isDefault` va incluido porque el resto de endpoints de presupuestos lo
      // devuelven y las apps distinguen con él las categorías propias.
      include: { category: { select: { id: true, name: true, icon: true, type: true, isDefault: true } } },
    });
  }, {
    // El default de Prisma son 5s. Quien llegue segundo al lock espera a que el
    // primero termine, así que se deja margen antes de abortar por timeout.
    maxWait: 10000,
    timeout: 15000,
  });
}

export default { recalculateBudgets, crearPresupuestoSinSolapar, buscarPresupuestoSolapado };
