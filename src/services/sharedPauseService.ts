import cron from 'node-cron';
import { prisma } from '../lib/prisma';
import { logger } from '../utils/logger';
import { subscriptionService } from './subscriptionService';
import { recalcularGrupoCompartido } from './budgetService';
import { avisar, lock, nombreDelGrupo, primerNombre } from './sharedService';
import { compartidosQueConservaTrasElTrial } from '../config/shared';

/**
 * Pausa y reactivación de compartidos según el plan del dueño (F3).
 *
 * Regla (v2): quedan activos los PRIMEROS que compartió, hasta el límite de su
 * plan; el resto se pausa. Pausado no es borrado: los miembros siguen en el
 * grupo y ven el aviso en lugar del compartido. Lo que gastan mientras está en
 * pausa no suma nunca (`pauseHistory`); lo de antes se queda. Si el dueño
 * vuelve a pagar, se reactiva solo.
 *
 * El estado es una función pura de (plan efectivo, compartidos abiertos), así
 * que reconciliar es idempotente y se puede llamar desde donde sea:
 *   - Al cambiar la suscripción (middleware de Prisma más abajo): cubre Stripe,
 *     RevenueCat, el fin del trial, las concesiones y cualquier camino futuro
 *     sin tener que acordarse de engancharlo en cada uno.
 *   - Cada hora, para todos los dueños con compartidos abiertos: las
 *     concesiones caducan sin que nadie escriba nada (se resuelven al leer), y
 *     es la red por si algo se escapa.
 *   - Al cerrar un compartido: si había uno pausado esperando lugar, entra.
 */

export interface ResultadoReconciliacion {
  pausados: string[];
  reactivados: string[];
}

/** Historial de pausas con la pausa actual ya cerrada (para guardarlo al reactivar o cerrar). */
export function historialAlCerrarPausa(grupo: { pausedAt: Date | null; pauseHistory: unknown }, hasta: Date) {
  const historial = Array.isArray(grupo.pauseHistory) ? [...(grupo.pauseHistory as any[])] : [];
  if (grupo.pausedAt) historial.push({ desde: grupo.pausedAt.toISOString(), hasta: hasta.toISOString() });
  return historial;
}

/** Cuánto puede tener activo el dueño ahora mismo. -1 = sin límite. */
async function cupoDelDueno(ownerId: string) {
  const sub = await subscriptionService.getUserSubscription(ownerId);
  const limits = sub.limits as any;
  const presupuestos = Number(limits.sharedBudgets ?? 0);
  const metas = Number(limits.sharedGoals ?? 0);
  // El disparador del trial: solo para quien salió del trial y no paga nada.
  const trasElTrial = sub.plan === 'FREE' && sub.trialEndedAt != null ? compartidosQueConservaTrasElTrial() : 0;
  return { presupuestos, metas, trasElTrial };
}

/**
 * Pone cada compartido abierto del dueño en el estado que le toca según su plan
 * y avisa a quien corresponda. Devuelve qué cambió.
 */
export async function reconciliarCompartidos(ownerId: string): Promise<ResultadoReconciliacion> {
  const cambios: ResultadoReconciliacion = await prisma.$transaction(async (tx) => {
    // El mismo lock que invitar: no se cruza con un compartido que se está creando.
    await lock(tx, `sharedowner:${ownerId}`);
    // El plan se lee DENTRO del lock: dos reconciliaciones seguidas no pueden
    // aplicar al final la que leyó el plan viejo.
    const cupo = await cupoDelDueno(ownerId);

    const grupos = await tx.sharedGroup.findMany({
      where: { ownerId, endedAt: null },
      select: { id: true, kind: true, pausedAt: true, pauseHistory: true },
      orderBy: [{ sharedAt: 'asc' }, { createdAt: 'asc' }],
    });

    const activos = new Set<string>();
    let presupuestos = 0;
    let metas = 0;
    for (const g of grupos) {
      if (g.kind === 'BUDGET' && (cupo.presupuestos === -1 || presupuestos < cupo.presupuestos)) {
        activos.add(g.id);
        presupuestos++;
      } else if (g.kind === 'GOAL' && (cupo.metas === -1 || metas < cupo.metas)) {
        activos.add(g.id);
        metas++;
      }
    }
    // Tras el trial: conserva los N primeros, sean presupuesto o meta.
    let extra = cupo.trasElTrial;
    for (const g of grupos) {
      if (extra <= 0) break;
      if (!activos.has(g.id)) {
        activos.add(g.id);
        extra--;
      }
    }

    const ahora = new Date();
    const pausar = grupos.filter((g) => !activos.has(g.id) && !g.pausedAt).map((g) => g.id);
    const reactivar = grupos.filter((g) => activos.has(g.id) && g.pausedAt).map((g) => g.id);
    if (pausar.length > 0) {
      await tx.sharedGroup.updateMany({ where: { id: { in: pausar } }, data: { pausedAt: ahora, pauseReason: 'PLAN' } });
    }
    for (const g of grupos.filter((x) => reactivar.includes(x.id))) {
      await tx.sharedGroup.update({
        where: { id: g.id },
        data: { pausedAt: null, pauseReason: null, pauseHistory: historialAlCerrarPausa(g, ahora) },
      });
    }
    return { pausados: pausar, reactivados: reactivar };
  }, { maxWait: 10000, timeout: 15000 });

  if (cambios.pausados.length === 0 && cambios.reactivados.length === 0) return cambios;
  logger.log(`[Shared] Dueño ${ownerId}: ${cambios.pausados.length} pausado(s), ${cambios.reactivados.length} reactivado(s)`);

  // Los presupuestos vuelven a sumar solo lo del dueño (pausa) o lo de todos
  // (reactivación).
  const tocados = await prisma.sharedGroup.findMany({
    where: { id: { in: [...cambios.pausados, ...cambios.reactivados] } },
    select: { id: true, kind: true },
  });
  for (const g of tocados) if (g.kind === 'BUDGET') await recalcularGrupoCompartido(g.id);

  await avisarCambios(ownerId, cambios, new Map(tocados.map((g) => [g.id, g.kind])));
  return cambios;
}

async function avisarCambios(ownerId: string, cambios: ResultadoReconciliacion, tipos: Map<string, string>) {
  const dueno = await prisma.user.findUnique({ where: { id: ownerId }, select: { name: true } });
  const nombreDueno = primerNombre(dueno?.name);
  const nombres = new Map<string, string>();
  for (const id of [...cambios.pausados, ...cambios.reactivados]) nombres.set(id, await nombreDelGrupo(id));

  for (const groupId of cambios.pausados) {
    const esMeta = tipos.get(groupId) === 'GOAL';
    const miembros = await prisma.sharedMember.findMany({
      where: { groupId, status: 'ACTIVE', role: 'MEMBER' },
      select: { userId: true },
    });
    for (const m of miembros) {
      await avisar(
        m.userId,
        'SHARED_STATUS',
        esMeta ? 'Una meta compartida está en pausa' : 'Un presupuesto compartido está en pausa',
        `${nombreDueno} cambió de plan y "${nombres.get(groupId)}" quedó en pausa. ` +
          (esMeta ? 'Lo que aportaste sigue registrado.' : 'Tus gastos siguen en tu historial.'),
        { groupId, screen: esMeta ? 'Goals' : 'Budgets' },
      );
    }
  }

  for (const groupId of cambios.reactivados) {
    const esMeta = tipos.get(groupId) === 'GOAL';
    const miembros = await prisma.sharedMember.findMany({
      where: { groupId, status: 'ACTIVE', role: 'MEMBER' },
      select: { userId: true },
    });
    for (const m of miembros) {
      await avisar(
        m.userId,
        'SHARED_STATUS',
        esMeta ? 'Tu meta compartida volvió' : 'Tu presupuesto compartido volvió',
        `"${nombres.get(groupId)}" está activo otra vez. Ya puedes ${esMeta ? 'aportar' : 'registrar gastos'} de nuevo.`,
        { groupId, screen: esMeta ? 'Goals' : 'Budgets' },
      );
    }
  }

  // Al dueño, un solo aviso por tanda.
  if (cambios.pausados.length > 0) {
    const lista = cambios.pausados.map((id) => `"${nombres.get(id)}"`).join(', ');
    await avisar(
      ownerId,
      'SHARED_STATUS',
      cambios.pausados.length === 1 ? 'Pausamos un compartido' : `Pausamos ${cambios.pausados.length} compartidos`,
      `Tu plan ya no incluye ${lista}. No se borró nada: mejora tu plan y vuelven a estar activos.`,
      { screen: 'Subscriptions' },
    );
  }
  if (cambios.reactivados.length > 0) {
    const lista = cambios.reactivados.map((id) => `"${nombres.get(id)}"`).join(', ');
    const soloMetas = cambios.reactivados.every((id) => tipos.get(id) === 'GOAL');
    await avisar(
      ownerId,
      'SHARED_STATUS',
      'Tus compartidos volvieron',
      `${lista} ${cambios.reactivados.length === 1 ? 'está activo' : 'están activos'} otra vez.`,
      { screen: soloMetas ? 'Goals' : 'Budgets' },
    );
  }
}

/** Igual que reconciliar, pero nunca lanza y no hace nada si no hay compartidos. */
export async function reconciliarCompartidosSeguro(ownerId: string): Promise<void> {
  try {
    const abiertos = await prisma.sharedGroup.count({ where: { ownerId, endedAt: null } });
    if (abiertos === 0) return;
    await reconciliarCompartidos(ownerId);
  } catch (error) {
    logger.error(`[Shared] Error reconciliando compartidos de ${ownerId}:`, error);
  }
}

/** Pasada completa: todos los dueños con compartidos abiertos. */
export async function reconciliarTodos(): Promise<void> {
  try {
    const duenos = await prisma.sharedGroup.findMany({
      where: { endedAt: null },
      distinct: ['ownerId'],
      select: { ownerId: true },
    });
    for (const d of duenos) await reconciliarCompartidosSeguro(d.ownerId);
  } catch (error) {
    logger.error('[Shared] Error en la pasada de reconciliación:', error);
  }
}

// ─── Enganche a los cambios de suscripción ────────────────────────────────────

/** Campos de `Subscription` que pueden cambiar lo que el dueño puede compartir. */
const CAMPOS_DE_PLAN = ['plan', 'status', 'grantedPlan', 'grantedUntil', 'trialEndedAt', 'trialEndsAt', 'trialStartedAt'];
const ESCRITURAS = new Set(['create', 'update', 'upsert', 'updateMany']);
const ESPERA_MS = 3000;
const pendientes = new Map<string, NodeJS.Timeout>();

function tocaElPlan(data: unknown): boolean {
  return !!data && typeof data === 'object' && CAMPOS_DE_PLAN.some((c) => c in (data as Record<string, unknown>));
}

/**
 * Programa una reconciliación para el usuario. Espera unos segundos y junta las
 * llamadas seguidas: los webhooks suelen escribir la suscripción varias veces, y
 * si la escritura va dentro de una transacción, hay que leer DESPUÉS del commit.
 */
export function programarReconciliacion(userId: string): void {
  const previa = pendientes.get(userId);
  if (previa) clearTimeout(previa);
  const t = setTimeout(() => {
    pendientes.delete(userId);
    void reconciliarCompartidosSeguro(userId);
  }, ESPERA_MS);
  t.unref?.();
  pendientes.set(userId, t);
}

let enganchado = false;

/**
 * Engancha la reconciliación a toda escritura de `Subscription` que toque el
 * plan. Hay ~40 sitios que escriben la suscripción (Stripe, RevenueCat, trial,
 * concesiones, auto-reparaciones); engancharlos uno a uno era garantía de
 * olvidar el próximo.
 */
export function engancharReconciliacionAlPlan(): void {
  if (enganchado) return;
  enganchado = true;
  prisma.$use(async (params, next) => {
    const resultado = await next(params);
    try {
      if (params.model === 'Subscription' && ESCRITURAS.has(params.action)) {
        const args = params.args ?? {};
        const relevante =
          params.action === 'create' ||
          tocaElPlan(args.data) ||
          tocaElPlan(args.create) ||
          tocaElPlan(args.update);
        const userId =
          (typeof args.where?.userId === 'string' && args.where.userId) ||
          (typeof args.data?.userId === 'string' && args.data.userId) ||
          (typeof args.create?.userId === 'string' && args.create.userId) ||
          (typeof (resultado as any)?.userId === 'string' && (resultado as any).userId) ||
          null;
        // Sin userId (p. ej. updateMany por id) lo recoge la pasada horaria.
        if (relevante && userId) programarReconciliacion(userId);
      }
    } catch (error) {
      logger.error('[Shared] Error programando reconciliación:', error);
    }
    return resultado;
  });
}

export class SharedPauseScheduler {
  static startScheduler(): void {
    engancharReconciliacionAlPlan();
    // Cada hora, al minuto 23 (lejos de los demás crons en punto).
    cron.schedule('23 * * * *', () => {
      void reconciliarTodos();
    });
    logger.log('[Shared] Reconciliación de compartidos programada: cada hora');
  }
}
