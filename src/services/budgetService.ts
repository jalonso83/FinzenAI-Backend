import { BudgetType } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { logger } from '../utils/logger';
import { NotificationService } from './notificationService';
import { subscriptionService } from './subscriptionService';
import { PLANS } from '../config/stripe';
import { recordFeatureUsage } from '../lib/featureUsage';
import { ExchangeRateService } from './exchangeRateService';
import { diaLocalKey, getTimezoneByCountry, inicioDiaLocalUtc } from '../utils/timezone';

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

/**
 * ─── Presupuestos compartidos (2026-10) ───────────────────────────────────────
 *
 * Un presupuesto compartido es una fila normal del DUEÑO con `shared_group_id`.
 * Su acumulado ya no es "lo que gastó el dueño" sino lo que gastaron todos los
 * miembros activos en esa categoría, salvo los gastos que cada uno sacó del
 * compartido (`sharedOptOut`). De cada miembro cuenta lo que gastó desde el día
 * en que entró. Si el grupo está pausado (el dueño bajó de plan) o cerrado,
 * vuelve a contar solo lo del dueño.
 *
 * Los gastos automáticos sin confirmar SÍ suman: la regla "solo el monto hasta
 * confirmar" es de lo que se MUESTRA a los demás, no de lo que se cuenta.
 *
 * Monedas: si un miembro usa otra moneda que el dueño, sus gastos se convierten
 * a la del dueño con el tipo de cambio de la app. Lo del dueño se suma tal cual,
 * igual que en un presupuesto personal.
 */

/** Campos de Budget que hacen falta para calcular su acumulado. */
export interface PresupuestoParaAcumulado {
  id: string;
  user_id: string;
  category_id: string;
  type: BudgetType;
  start_date: Date;
  end_date: Date;
  shared_group_id: string | null;
}

interface Aportante {
  userId: string;
  /** Desde cuándo cuentan sus gastos. null = todo el período (el dueño). */
  desde: Date | null;
  /** Hasta cuándo (salió del grupo). null = sigue dentro. Solo en períodos cerrados. */
  hasta: Date | null;
  moneda: string;
  /** Pausas del grupo: lo que gastó en esos tramos no cuenta. hasta null = sigue en pausa. */
  excluir?: { desde: Date; hasta: Date | null }[];
}

/** Tramos en pausa de un grupo: los terminados (historial) y el actual, si lo hay. */
export function tramosEnPausa(grupo: { pausedAt: Date | null; pauseHistory?: unknown }): { desde: Date; hasta: Date | null }[] {
  const tramos: { desde: Date; hasta: Date | null }[] = [];
  const historial = Array.isArray(grupo.pauseHistory) ? grupo.pauseHistory : [];
  for (const t of historial as any[]) {
    const desde = new Date(t?.desde);
    const hasta = new Date(t?.hasta);
    if (!isNaN(desde.getTime()) && !isNaN(hasta.getTime())) tramos.push({ desde, hasta });
  }
  if (grupo.pausedAt) tramos.push({ desde: grupo.pausedAt, hasta: null });
  return tramos;
}

/**
 * Inicio del día LOCAL (según su país) en que entró: lo de ese día ya cuenta.
 * En UTC, quien entra a las 10 de la noche en RD (02:00 UTC del día siguiente)
 * perdía los gastos de esa misma tarde.
 */
function inicioDelDiaLocal(fecha: Date, pais: string | null | undefined): Date {
  const zona = getTimezoneByCountry(pais);
  return inicioDiaLocalUtc(zona, diaLocalKey(zona, fecha));
}

/**
 * Quiénes alimentan el acumulado del presupuesto. Sin grupo solo el dueño.
 *
 * Período VIGENTE: el dueño y los miembros activos, cada uno desde el día en que
 * entró. Si el grupo está cerrado, solo el dueño.
 *
 * Pausa (el dueño bajó de plan): lo que los miembros gastan MIENTRAS está en
 * pausa no cuenta nunca; lo que ya habían aportado antes se queda. Así el
 * presupuesto no se desploma al pausar ni se infla al reactivar.
 *
 * Período CERRADO (ya terminó): quien estuvo en el grupo en algún momento de esa
 * ventana, cada uno entre que entró y que salió. Así, recalcular un mes viejo
 * (lo hace la exclusión de tarjetas) no le borra lo que aportó alguien que salió
 * después, ni lo pierde porque el grupo se cerró más tarde.
 */
export async function aportantesDePresupuesto(
  cliente: any,
  budget: Pick<PresupuestoParaAcumulado, 'user_id' | 'shared_group_id' | 'start_date' | 'end_date'>,
): Promise<{ aportantes: Aportante[]; compartidoActivo: boolean; monedaDueno: string }> {
  const dueno = await cliente.user.findUnique({ where: { id: budget.user_id }, select: { currency: true } });
  const monedaDueno = dueno?.currency || '';
  const soloDueno = {
    aportantes: [{ userId: budget.user_id, desde: null, hasta: null, moneda: monedaDueno }],
    compartidoActivo: false,
    monedaDueno,
  };

  if (!budget.shared_group_id) return soloDueno;

  const grupo = await cliente.sharedGroup.findUnique({
    where: { id: budget.shared_group_id },
    select: {
      pausedAt: true,
      pauseHistory: true,
      endedAt: true,
      members: {
        select: {
          userId: true, status: true, joinedAt: true, leftAt: true,
          user: { select: { currency: true, country: true } },
        },
      },
    },
  });
  if (!grupo) return soloDueno;

  const cerrado = budget.end_date < new Date();
  if (!cerrado && grupo.endedAt) return soloDueno;
  const excluir = tramosEnPausa(grupo);

  const aportantes: Aportante[] = [soloDueno.aportantes[0]];
  for (const m of grupo.members) {
    if (m.userId === budget.user_id) continue; // el dueño ya está, sin fecha de corte
    if (!cerrado) {
      if (m.status !== 'ACTIVE') continue;
      aportantes.push({
        userId: m.userId,
        desde: inicioDelDiaLocal(m.joinedAt, m.user?.country),
        hasta: null,
        moneda: m.user?.currency || '',
        excluir,
      });
      continue;
    }
    // Cerrado: ¿estuvo dentro en algún momento de la ventana?
    if (m.joinedAt > budget.end_date) continue;
    if (m.leftAt && m.leftAt < budget.start_date) continue;
    if (m.status !== 'ACTIVE' && !m.leftAt) continue;
    aportantes.push({
      userId: m.userId,
      desde: inicioDelDiaLocal(m.joinedAt, m.user?.country),
      hasta: m.leftAt ?? null,
      moneda: m.user?.currency || '',
      excluir,
    });
  }
  return { aportantes, compartidoActivo: aportantes.length > 1, monedaDueno };
}

/** ¿Este gasto entra en la ventana del aportante? */
export function dentroDeVentana(aportante: Aportante, fecha: Date): boolean {
  if (aportante.desde && fecha < aportante.desde) return false;
  if (aportante.hasta && fecha > aportante.hasta) return false;
  for (const t of aportante.excluir ?? []) {
    if (fecha >= t.desde && (!t.hasta || fecha < t.hasta)) return false;
  }
  return true;
}

/**
 * Conversor con caché por llamada: un recálculo pide la misma tasa muchas veces.
 *
 * La tasa se saca convirtiendo un millón y dividiendo: `convert(1, …).rate` en
 * el camino cruzado (ninguna de las dos monedas es DOP) viene redondeada a 4
 * decimales, y 1/60 = 0.016667 quedaba en 0.0167 — un 0.2 % de error en cada
 * gasto convertido.
 */
export function crearConversor() {
  const tasas = new Map<string, number>();
  return async (monto: number, de: string, a: string): Promise<number> => {
    if (!de || !a || de === a) return monto;
    const clave = `${de}>${a}`;
    let tasa = tasas.get(clave);
    if (tasa === undefined) {
      try {
        tasa = (await ExchangeRateService.convert(1_000_000, de, a)).amount / 1_000_000;
      } catch (error) {
        logger.error(`[BudgetService] No se pudo convertir ${de}→${a}; se suma sin convertir:`, error);
        tasa = 1;
      }
      tasas.set(clave, tasa);
    }
    return Math.round(monto * tasa * 100) / 100;
  };
}

/**
 * Acumulado de UN presupuesto, personal o compartido. Recibe el cliente para
 * poder usarse dentro de una transacción (la renovación lo hace).
 */
export async function calcularAcumulado(cliente: any, budget: PresupuestoParaAcumulado): Promise<number> {
  const { aportantes, compartidoActivo, monedaDueno } = await aportantesDePresupuesto(cliente, budget);

  const transacciones: { userId: string; amount: number; date: Date; source: string }[] =
    await cliente.transaction.findMany({
      where: {
        userId: { in: aportantes.map((a) => a.userId) },
        category_id: budget.category_id,
        type: budget.type,
        date: { gte: budget.start_date, lte: budget.end_date },
        // Sacar un gasto del compartido solo tiene efecto en un compartido. En
        // un presupuesto personal el gasto cuenta igual.
        ...(compartidoActivo ? { sharedOptOut: false } : {}),
      },
      select: { userId: true, amount: true, date: true, source: true },
    });

  if (!compartidoActivo) {
    return transacciones.reduce((sum, t) => sum + Number(t.amount), 0);
  }

  const porUsuario = new Map(aportantes.map((a) => [a.userId, a]));
  const convertir = crearConversor();
  let total = 0;
  for (const t of transacciones) {
    const aportante = porUsuario.get(t.userId);
    if (!aportante) continue;
    if (!dentroDeVentana(aportante, t.date)) continue;
    if (t.userId === budget.user_id) {
      total += Number(t.amount);
      continue;
    }
    // Lo que entra por correo se guarda siempre en pesos (emailSyncService
    // convierte a DOP), sin importar la moneda del usuario.
    const monedaGasto = t.source === 'EMAIL' ? 'DOP' : aportante.moneda;
    total += await convertir(Number(t.amount), monedaGasto, monedaDueno);
  }
  return Math.round(total * 100) / 100;
}

/**
 * Presupuestos activos de esa categoría, cuyo período incluye la fecha, a los
 * que alimentan los movimientos de `userId`: los suyos y los compartidos donde
 * es miembro.
 */
async function presupuestosAfectados(userId: string, categoryId: string, date: Date) {
  const include = { user: { select: { currency: true } } };
  const propios = await prisma.budget.findMany({
    where: {
      user_id: userId,
      category_id: categoryId,
      is_active: true,
      start_date: { lte: date },
      end_date: { gte: date },
    },
    include,
  });

  const membresias = await prisma.sharedMember.findMany({
    where: {
      userId,
      role: 'MEMBER',
      status: 'ACTIVE',
      group: { kind: 'BUDGET', categoryId, pausedAt: null, endedAt: null },
    },
    select: { groupId: true },
  });
  if (membresias.length === 0) return propios;

  const compartidos = await prisma.budget.findMany({
    where: {
      shared_group_id: { in: membresias.map((m) => m.groupId) },
      category_id: categoryId,
      is_active: true,
      start_date: { lte: date },
      end_date: { gte: date },
    },
    include,
  });
  const ids = new Set(propios.map((b) => b.id));
  return [...propios, ...compartidos.filter((b) => !ids.has(b.id))];
}

/** A quién avisar de un umbral: a todos los miembros activos si está compartido. */
async function destinatariosDeAlerta(budget: { user_id: string; shared_group_id: string | null }): Promise<string[]> {
  if (!budget.shared_group_id) return [budget.user_id];
  const grupo = await prisma.sharedGroup.findUnique({
    where: { id: budget.shared_group_id },
    select: { pausedAt: true, endedAt: true, members: { where: { status: 'ACTIVE' }, select: { userId: true } } },
  });
  if (!grupo || grupo.pausedAt || grupo.endedAt) return [budget.user_id];
  return Array.from(new Set([budget.user_id, ...grupo.members.map((m) => m.userId)]));
}

export async function recalculateBudgets(
  userId: string,
  categoryId: string,
  date: Date,
  options: RecalcOptions = {},
): Promise<void> {
  const { notify = false } = options;

  try {
    // Presupuestos activos de esa categoría cuyo período incluya la fecha: los
    // del usuario y los compartidos donde es miembro.
    const budgets = await presupuestosAfectados(userId, categoryId, date);

    if (budgets.length === 0) return;

    // ¿Puede alertar? Lo decide el plan del DUEÑO de cada presupuesto (en un
    // compartido, el invitado recibe las alertas porque el dueño paga). Se
    // consulta una vez por dueño y solo si hace falta.
    const alertasPorDueno = new Map<string, boolean>();
    const puedeAlertar = async (duenoId: string): Promise<boolean> => {
      if (!notify) return false;
      const enCache = alertasPorDueno.get(duenoId);
      if (enCache !== undefined) return enCache;
      let puede = false;
      try {
        const subscription = await subscriptionService.getUserSubscription(duenoId);
        const planLimits = subscription.limits as { budgetAlerts?: boolean };
        puede = planLimits.budgetAlerts ?? PLANS.FREE.limits.budgetAlerts;
      } catch (error) {
        logger.error('[BudgetService] No se pudo leer el plan; no se alerta:', error);
      }
      alertasPorDueno.set(duenoId, puede);
      return puede;
    };

    for (const budget of budgets) {
      const anterior = Number(budget.spent) || 0;

      // Un presupuesto de gasto se nutre de transacciones EXPENSE y uno de
      // ingreso de INCOME; calcularAcumulado filtra por `budget.type`.
      const acumulado = await calcularAcumulado(prisma, budget);

      // Escribir solo si cambió: evita updates inútiles y toques de updated_at.
      if (acumulado !== anterior) {
        await prisma.budget.update({ where: { id: budget.id }, data: { spent: acumulado } });
      }

      // Las alertas de umbral son exclusivas de los presupuestos de GASTO.
      if (budget.type !== BudgetType.EXPENSE || !(await puedeAlertar(budget.user_id))) continue;

      const monto = Number(budget.amount);
      if (!(monto > 0)) continue; // presupuesto en 0 → todo porcentaje sería infinito

      const umbral = Number(budget.alert_percentage) || 80;
      const currency = budget.user?.currency || 'RD$';
      const pctAntes = (anterior / monto) * 100;
      const pctAhora = (acumulado / monto) * 100;

      const cruzaUmbral = pctAntes < umbral && pctAhora >= umbral && pctAhora < 100;
      const excede = pctAntes < 100 && pctAhora >= 100;
      if (!cruzaUmbral && !excede) continue;

      const destinatarios = await destinatariosDeAlerta(budget);
      const nombre = destinatarios.length > 1 ? `${budget.name} (compartido)` : budget.name;

      try {
        // Cruce del umbral de aviso (sin haber llegado todavía al 100%).
        if (cruzaUmbral) {
          // Entrega REAL de una función de pago: las alertas de umbral son de
          // Plus y Pro (`budgetAlerts: false` en FREE). A diferencia de las
          // demás, esta el usuario no la pide — se la entregamos. Medirla dice
          // si el plan de pago está haciendo algo por él además de existir.
          recordFeatureUsage(budget.user_id, 'premium', 'alerta_umbral');

          for (const destinatario of destinatarios) {
            await NotificationService.notifyBudgetAlert(
              destinatario,
              nombre,
              Math.round(pctAhora),
              monto - acumulado,
              currency,
            );
          }
        }

        // Presupuesto excedido.
        if (excede) {
          for (const destinatario of destinatarios) {
            await NotificationService.notifyBudgetExceeded(
              destinatario,
              nombre,
              acumulado - monto,
              currency,
            );
          }
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
 * Recalcula (sin alertas) los presupuestos ACTIVOS de un grupo compartido. Se
 * usa cuando cambia quién aporta: alguien entra o sale, el grupo se pausa o se
 * cierra, o un miembro saca un gasto del compartido.
 */
export async function recalcularGrupoCompartido(groupId: string): Promise<void> {
  try {
    const budgets = await prisma.budget.findMany({ where: { shared_group_id: groupId, is_active: true } });
    for (const budget of budgets) {
      const acumulado = await calcularAcumulado(prisma, budget);
      if (acumulado !== (Number(budget.spent) || 0)) {
        await prisma.budget.update({ where: { id: budget.id }, data: { spent: acumulado } });
      }
    }
  } catch (error) {
    logger.error(`[BudgetService] Error recalculando grupo compartido ${groupId}:`, error);
  }
}

/**
 * Recalcula (sin alertas) los presupuestos compartidos —activos o ya cerrados—
 * que tocan los movimientos de `userId` en esas categorías y fechas. Lo usa la
 * exclusión de tarjetas, que borra consumos de hasta 90 días atrás: el SQL de
 * los cerrados que tiene allí solo sabe sumar lo del dueño.
 */
export async function recalcularCompartidosEnRango(
  userId: string,
  categoryIds: string[],
  desde: Date,
  hasta: Date,
): Promise<void> {
  try {
    const grupos = await prisma.sharedMember.findMany({
      where: { userId, group: { kind: 'BUDGET', categoryId: { in: categoryIds } } },
      select: { groupId: true },
    });
    if (grupos.length === 0) return;
    const budgets = await prisma.budget.findMany({
      where: {
        shared_group_id: { in: grupos.map((g) => g.groupId) },
        category_id: { in: categoryIds },
        start_date: { lte: hasta },
        end_date: { gte: desde },
      },
    });
    for (const budget of budgets) {
      const acumulado = await calcularAcumulado(prisma, budget);
      if (acumulado !== (Number(budget.spent) || 0)) {
        await prisma.budget.update({ where: { id: budget.id }, data: { spent: acumulado } });
      }
    }
  } catch (error) {
    logger.error('[BudgetService] Error recalculando compartidos en rango:', error);
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

export default {
  recalculateBudgets,
  recalcularGrupoCompartido,
  recalcularCompartidosEnRango,
  calcularAcumulado,
  crearPresupuestoSinSolapar,
  buscarPresupuestoSolapado,
};
