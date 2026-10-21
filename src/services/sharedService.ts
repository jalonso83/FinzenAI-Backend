import { randomInt } from 'crypto';
import { NotificationType } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { logger } from '../utils/logger';
import { NotificationService } from './notificationService';
import { subscriptionService } from './subscriptionService';
import {
  aportantesDePresupuesto,
  calcularAcumulado,
  crearConversor,
  dentroDeVentana,
  recalcularGrupoCompartido,
  recalculateBudgets,
} from './budgetService';
import {
  isSharedEnabled,
  SHARED_CODE_ALPHABET,
  SHARED_CODE_LENGTH,
  SHARED_INVITE_TTL_DAYS,
  SHARED_MAX_MEMBERS,
  sharedInviteLink,
} from '../config/shared';
import { historialAlCerrarPausa, reconciliarCompartidosSeguro } from './sharedPauseService';

/**
 * Presupuestos y metas compartidos (2026-10). Lo específico de metas (aportes con
 * nombre, salir con o sin aportes) vive en sharedGoalService.ts; grupos,
 * miembros e invitaciones son comunes y viven aquí.
 *
 * Reglas de producto (presupuestos-y-metas-compartidos-finzen-v2.html y las
 * decisiones del 2026-10-16):
 *   - Comparte el dueño con Plus (2) o Pro (ilimitados). FREE no comparte.
 *   - El invitado entra gratis con cualquier plan; no le cuenta para sus límites.
 *   - Hasta 4 personas por compartido, contando al dueño.
 *   - Solo el dueño edita. Los miembros aportan, salen cuando quieren.
 *   - Compartir una categoría es un acuerdo: todo gasto de esa categoría cuenta,
 *     se puede sacar uno a uno.
 *   - Una persona está en UN solo compartido por categoría.
 *   - Los gastos automáticos (correo) de cualquiera se ven solo por el monto
 *     hasta que quien los hizo los confirma.
 */

export class SharedError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'SharedError';
  }
}

// ─── Utilidades ───────────────────────────────────────────────────────────────

export function generarCodigo(): string {
  let codigo = '';
  for (let i = 0; i < SHARED_CODE_LENGTH; i++) {
    codigo += SHARED_CODE_ALPHABET[randomInt(SHARED_CODE_ALPHABET.length)];
  }
  return codigo;
}

/** Normaliza lo que escribe la persona: mayúsculas, sin espacios ni guiones. */
export function normalizarCodigo(codigo: string): string {
  return String(codigo || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function primerNombre(nombre?: string | null): string {
  return (nombre || '').trim().split(/\s+/)[0] || 'Alguien';
}

export async function avisar(userId: string, type: NotificationType, title: string, body: string, data: Record<string, string>) {
  try {
    await NotificationService.sendToUser(userId, type, { title, body, data: { type, ...data } });
  } catch (error) {
    // Avisar nunca debe romper la operación que lo dispara.
    logger.error(`[Shared] Error notificando a ${userId}:`, error);
  }
}

/** Lock de transacción (se libera solo al terminar), mismo patrón que budgetService. */
export async function lock(tx: any, clave: string) {
  await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', clave);
}

/**
 * IDs de transacciones que entraron por correo. `source` lo dice para lo nuevo;
 * lo anterior a 2026-10 quedó como MANUAL, así que también se mira el enlace
 * correo → transacción.
 */
async function idsDeCorreo(transactionIds: string[]): Promise<Set<string>> {
  if (transactionIds.length === 0) return new Set();
  const filas = await prisma.importedBankEmail.findMany({
    where: { transactionId: { in: transactionIds } },
    select: { transactionId: true },
  });
  return new Set(filas.map((f) => f.transactionId!).filter(Boolean));
}

/** ¿Este gasto todavía se muestra solo por el monto a los demás? */
function porConfirmar(t: { source: string; sharedConfirmedAt: Date | null; id: string }, deCorreo: Set<string>) {
  return t.sharedConfirmedAt == null && (t.source === 'EMAIL' || deCorreo.has(t.id));
}

/**
 * Compartido de presupuesto donde ya está la persona (como dueña o miembro) en
 * esa categoría. Regla: uno solo por categoría.
 */
async function compartidoEnCategoria(userId: string, categoryId: string, excluirGroupId?: string) {
  return prisma.sharedMember.findFirst({
    where: {
      userId,
      status: 'ACTIVE',
      ...(excluirGroupId ? { groupId: { not: excluirGroupId } } : {}),
      group: { kind: 'BUDGET', categoryId, endedAt: null },
    },
    select: { group: { select: { id: true, budgets: { where: { is_active: true }, select: { name: true }, take: 1 } } } },
  });
}

/** Presupuesto vigente de un grupo: la fila activa más reciente. */
async function presupuestoVigente(groupId: string) {
  return prisma.budget.findFirst({
    where: { shared_group_id: groupId, is_active: true },
    orderBy: { start_date: 'desc' },
    include: { category: { select: { id: true, name: true, icon: true, type: true, isDefault: true } } },
  });
}

// ─── Invitar ──────────────────────────────────────────────────────────────────

export async function invitarAPresupuesto(ownerId: string, budgetId: string) {
  if (!isSharedEnabled(ownerId)) {
    throw new SharedError(403, 'FEATURE_DISABLED', 'Compartir presupuestos todavía no está disponible para tu cuenta.');
  }

  const budget = await prisma.budget.findFirst({
    where: { id: budgetId, user_id: ownerId },
    include: { category: { select: { name: true } }, user: { select: { name: true } } },
  });
  if (!budget) throw new SharedError(404, 'NOT_FOUND', 'No encontramos ese presupuesto.');
  if (!budget.is_active) throw new SharedError(400, 'BUDGET_INACTIVE', 'Solo puedes compartir un presupuesto activo.');
  if (budget.type !== 'EXPENSE') {
    throw new SharedError(400, 'INCOME_NOT_SUPPORTED', 'Por ahora solo se pueden compartir presupuestos de gastos.');
  }

  // Todo lo que decide si se crea un grupo va dentro de una transacción con
  // lock por dueño: dos toques seguidos a "Invitar" (o tres presupuestos a la
  // vez) creaban grupos de más — uno huérfano, o pasaban del límite del plan.
  const groupId: string = await prisma.$transaction(async (tx) => {
    await lock(tx, `sharedowner:${ownerId}`);
    await lock(tx, `sharedcat:${ownerId}:${budget.category_id}`);

    const actual = await tx.budget.findUnique({ where: { id: budget.id }, select: { shared_group_id: true } });
    if (actual?.shared_group_id) {
      const grupo = await tx.sharedGroup.findUnique({
        where: { id: actual.shared_group_id },
        select: { id: true, pausedAt: true, endedAt: true },
      });
      if (grupo && !grupo.endedAt) {
        if (grupo.pausedAt) {
          throw new SharedError(409, 'SHARED_PAUSED',
            'Este compartido está en pausa porque tu plan cambió. Mejora tu plan para reactivarlo.', { upgrade: true });
        }
        return grupo.id; // ya está compartido: solo otra invitación
      }
    }

    // Compartir uno nuevo: plan y regla de una categoría.
    const sub = await subscriptionService.getUserSubscription(ownerId);
    const limite = Number((sub.limits as any).sharedBudgets ?? 0);
    if (limite !== -1) {
      // Los pausados cuentan: tienen prioridad sobre uno nuevo (quedan activos
      // los primeros que se compartieron), así que compartir otro solo lo
      // dejaría pausado en cuanto se reconcilie.
      const actuales = await tx.sharedGroup.count({
        where: { ownerId, kind: 'BUDGET', endedAt: null },
      });
      if (actuales >= limite) {
        throw new SharedError(
          403,
          'SHARED_LIMIT',
          limite === 0
            ? 'Compartir presupuestos es parte de Plus y Pro.'
            : `Tu plan permite compartir hasta ${limite} presupuestos, contando los que están en pausa. Deja de compartir uno o mejora tu plan.`,
          { upgrade: true, limitType: 'sharedBudgets', limit: limite, current: actuales, currentPlan: sub.plan },
        );
      }
    }

    const conflicto = await tx.sharedMember.findFirst({
      where: { userId: ownerId, status: 'ACTIVE', group: { kind: 'BUDGET', categoryId: budget.category_id, endedAt: null } },
      select: { group: { select: { budgets: { where: { is_active: true }, select: { name: true }, take: 1 } } } },
    });
    if (conflicto) {
      throw new SharedError(409, 'CATEGORY_CONFLICT',
        `Ya compartes ${budget.category.name} en "${conflicto.group.budgets[0]?.name ?? 'otro presupuesto'}". Solo puedes estar en un compartido por categoría.`);
    }

    const nuevo = await tx.sharedGroup.create({
      data: {
        kind: 'BUDGET',
        ownerId,
        categoryId: budget.category_id,
        members: { create: { userId: ownerId, role: 'OWNER' } },
      },
    });
    await tx.budget.update({ where: { id: budget.id }, data: { shared_group_id: nuevo.id } });
    return nuevo.id;
  }, { maxWait: 10000, timeout: 15000 });

  const activos = await prisma.sharedMember.count({ where: { groupId, status: 'ACTIVE' } });
  if (activos >= SHARED_MAX_MEMBERS) {
    throw new SharedError(409, 'GROUP_FULL', `Un presupuesto compartido admite hasta ${SHARED_MAX_MEMBERS} personas, contándote a ti.`);
  }

  const expiresAt = new Date(Date.now() + SHARED_INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);
  let invitacion: { code: string; expiresAt: Date } | null = null;
  for (let intento = 0; intento < 5 && !invitacion; intento++) {
    try {
      invitacion = await prisma.sharedInvitation.create({
        data: { code: generarCodigo(), groupId, inviterId: ownerId, expiresAt },
        select: { code: true, expiresAt: true },
      });
    } catch (error: any) {
      if (error?.code !== 'P2002') throw error; // choque de código: otro intento
    }
  }
  if (!invitacion) throw new Error('No se pudo generar un código de invitación único');

  const link = sharedInviteLink(invitacion.code);
  const nombreDueno = primerNombre(budget.user?.name);
  return {
    code: invitacion.code,
    link,
    expiresAt: invitacion.expiresAt,
    groupId,
    mensaje:
      `${nombreDueno} te invita a llevar juntos el presupuesto "${budget.name}" en FinZen. ` +
      `Abre el enlace: ${link}\n` +
      `Si todavía no tienes FinZen, descárgalo y escribe el código ${invitacion.code} al registrarte.`,
  };
}

// ─── Ver y aceptar una invitación ─────────────────────────────────────────────

/**
 * Lo que ve CUALQUIERA que abra el enlace, sin sesión (página /invite/CÓDIGO
 * de la landing y su vista previa en WhatsApp). Solo quién invita (primer
 * nombre), qué es y el estado: ni montos, ni miembros, ni nada del grupo.
 */
export async function vistaPublicaInvitacion(codigo: string) {
  const v = await verInvitacion(codigo);
  const item = v.meta ?? v.presupuesto;
  return {
    code: v.code,
    tipo: v.kind === 'GOAL' ? 'meta' : 'presupuesto',
    estado: v.estado,
    dueno: v.dueno,
    nombre: item?.nombre ?? null,
    icono: item?.categoria?.icon ?? null,
    expiresAt: v.expiresAt,
  };
}

type EstadoInvitacion = 'valida' | 'vencida' | 'usada' | 'revocada' | 'cerrada' | 'pausada' | 'llena';

export async function verInvitacion(codigo: string, viewerId?: string) {
  const code = normalizarCodigo(codigo);
  const inv = await prisma.sharedInvitation.findUnique({
    where: { code },
    include: {
      inviter: { select: { name: true, currency: true } },
      group: { select: { id: true, kind: true, ownerId: true, categoryId: true, goalId: true, pausedAt: true, endedAt: true } },
    },
  });
  if (!inv) throw new SharedError(404, 'INVITE_NOT_FOUND', 'Ese código no existe. Revisa que esté bien escrito.');

  const esMeta = inv.group.kind === 'GOAL';
  const budget = esMeta ? null : await presupuestoVigente(inv.group.id);
  const goal = esMeta && inv.group.goalId
    ? await prisma.goal.findUnique({
        where: { id: inv.group.goalId },
        include: { category: { select: { id: true, name: true, icon: true } } },
      })
    : null;
  const disponible = esMeta ? !!goal && goal.isActive && !goal.isCompleted : !!budget;
  const activos = await prisma.sharedMember.count({ where: { groupId: inv.group.id, status: 'ACTIVE' } });

  let estado: EstadoInvitacion = 'valida';
  if (inv.status === 'ACCEPTED') estado = 'usada';
  else if (inv.status === 'REVOKED') estado = 'revocada';
  else if (inv.group.endedAt || !disponible) estado = 'cerrada';
  else if (inv.expiresAt < new Date()) estado = 'vencida';
  else if (inv.group.pausedAt) estado = 'pausada';
  else if (activos >= SHARED_MAX_MEMBERS) estado = 'llena';

  const nombreDueno = primerNombre(inv.inviter?.name);

  let yaEsMiembro = false;
  let conflicto: string | null = null;
  if (viewerId) {
    yaEsMiembro = !!(await prisma.sharedMember.findFirst({
      where: { groupId: inv.group.id, userId: viewerId, status: 'ACTIVE' },
      select: { id: true },
    }));
    // La regla de "uno por categoría" es solo de presupuestos.
    if (!yaEsMiembro && !esMeta && inv.group.categoryId) {
      const otro = await compartidoEnCategoria(viewerId, inv.group.categoryId, inv.group.id);
      if (otro) {
        conflicto = `Ya compartes ${budget?.category?.name ?? 'esa categoría'} en "${otro.group.budgets[0]?.name ?? 'otro presupuesto'}". ` +
          'Sal de ese compartido para unirte a este.';
      }
    }
  }

  const comun = {
    code,
    kind: inv.group.kind,
    estado,
    esDueno: viewerId === inv.group.ownerId,
    yaEsMiembro,
    dueno: nombreDueno,
    // Montos en la moneda de quien invita (el dueño).
    moneda: inv.inviter?.currency || '',
    miembros: activos,
    maxMiembros: SHARED_MAX_MEMBERS,
    expiresAt: inv.expiresAt,
    conflicto,
  };

  if (esMeta) {
    const nombre = goal?.name ?? 'la meta';
    return {
      ...comun,
      presupuesto: null,
      meta: goal
        ? {
            nombre,
            objetivo: Number(goal.targetAmount),
            ahorrado: Number(goal.currentAmount),
            fechaObjetivo: goal.targetDate,
            categoria: { id: goal.category.id, name: goal.category.name, icon: goal.category.icon },
          }
        : null,
      // Lo que acepta, dicho tal cual en la pantalla antes del botón.
      acuerdo:
        `Tus aportes a "${nombre}" quedan con tu nombre y ${nombreDueno} los ve. ` +
        `Solo ${nombreDueno} puede cambiar el monto, la fecha o borrar la meta. Puedes salir cuando quieras.`,
    };
  }

  const categoria = budget?.category?.name ?? 'esa categoría';
  const nombre = budget?.name ?? 'el presupuesto';
  return {
    ...comun,
    meta: null,
    presupuesto: budget
      ? {
          nombre,
          monto: Number(budget.amount),
          periodo: budget.period,
          categoria: { id: budget.category.id, name: budget.category.name, icon: budget.category.icon },
        }
      : null,
    // Lo que acepta, dicho tal cual en la pantalla antes del botón.
    acuerdo:
      `Todos tus gastos de ${categoria}, incluidos los que entran solos por correo, se cuentan en "${nombre}" ` +
      `y ${nombreDueno} los ve. Los que entran solos se ven solo por el monto hasta que los confirmes. ` +
      `Puedes sacar un gasto o salir cuando quieras.`,
  };
}

export async function aceptarInvitacion(codigo: string, userId: string) {
  const code = normalizarCodigo(codigo);
  const inv = await prisma.sharedInvitation.findUnique({
    where: { code },
    include: { group: { select: { id: true, ownerId: true, categoryId: true, goalId: true, kind: true } } },
  });
  if (!inv) throw new SharedError(404, 'INVITE_NOT_FOUND', 'Ese código no existe. Revisa que esté bien escrito.');
  if (!isSharedEnabled(inv.group.ownerId)) {
    throw new SharedError(403, 'FEATURE_DISABLED', 'Esta invitación todavía no está disponible.');
  }
  if (inv.group.ownerId === userId) throw new SharedError(400, 'OWN_INVITE', 'Esta invitación es tuya: compártela con la otra persona.');

  const groupId = inv.group.id;
  const esMeta = inv.group.kind === 'GOAL';
  const categoryId = inv.group.categoryId;
  const queEs = esMeta ? 'Esta meta' : 'Este presupuesto';

  const resultado = await prisma.$transaction(async (tx) => {
    // El grupo, para que dos aceptaciones simultáneas no pasen de 4; en
    // presupuestos, también la persona y la categoría, para que no entre a dos
    // compartidos de lo mismo a la vez.
    await lock(tx, `shared:${groupId}`);
    if (!esMeta && categoryId) await lock(tx, `sharedcat:${userId}:${categoryId}`);

    const actual = await tx.sharedInvitation.findUnique({ where: { id: inv.id } });
    const grupo = await tx.sharedGroup.findUnique({ where: { id: groupId } });
    if (!actual || !grupo) throw new SharedError(404, 'INVITE_NOT_FOUND', 'Esta invitación ya no existe.');

    const yaMiembro = await tx.sharedMember.findUnique({ where: { groupId_userId: { groupId, userId } } });
    if (yaMiembro?.status === 'ACTIVE') return { yaEraMiembro: true };

    if (actual.status === 'ACCEPTED') throw new SharedError(409, 'INVITE_USED', 'Esta invitación ya se usó. Pídele a quien te invitó un código nuevo.');
    const cerrada = `${queEs} ya no se está compartiendo.`;
    if (actual.status === 'REVOKED' || grupo.endedAt) throw new SharedError(409, 'INVITE_CLOSED', cerrada);
    if (actual.expiresAt < new Date()) throw new SharedError(409, 'INVITE_EXPIRED', 'Esta invitación venció. Pídele a quien te invitó un código nuevo.');
    if (grupo.pausedAt) {
      throw new SharedError(409, 'SHARED_PAUSED',
        esMeta ? 'Esta meta compartida está en pausa por ahora.' : 'Este presupuesto compartido está en pausa por ahora.');
    }
    if (esMeta) {
      const goal = grupo.goalId ? await tx.goal.findUnique({ where: { id: grupo.goalId } }) : null;
      if (!goal || !goal.isActive) throw new SharedError(409, 'INVITE_CLOSED', cerrada);
      if (goal.isCompleted) throw new SharedError(409, 'GOAL_COMPLETED', 'Esta meta ya se cumplió.');
    } else {
      const vigentes = await tx.budget.count({ where: { shared_group_id: groupId, is_active: true } });
      if (vigentes === 0) throw new SharedError(409, 'INVITE_CLOSED', cerrada);
    }

    const activos = await tx.sharedMember.count({ where: { groupId, status: 'ACTIVE' } });
    if (activos >= SHARED_MAX_MEMBERS) throw new SharedError(409, 'GROUP_FULL', `${queEs} ya tiene el máximo de personas.`);

    if (!esMeta) {
      const otro = await tx.sharedMember.findFirst({
        where: { userId, status: 'ACTIVE', groupId: { not: groupId }, group: { kind: 'BUDGET', categoryId, endedAt: null } },
        select: { group: { select: { budgets: { where: { is_active: true }, select: { name: true }, take: 1 } } } },
      });
      if (otro) {
        throw new SharedError(409, 'CATEGORY_CONFLICT',
          `Ya compartes esa categoría en "${otro.group.budgets[0]?.name ?? 'otro presupuesto'}". Sal de ese compartido para unirte a este.`);
      }
    }

    const ahora = new Date();
    if (yaMiembro) {
      // Había salido o lo habían quitado: vuelve a entrar y cuenta desde hoy.
      await tx.sharedMember.update({
        where: { id: yaMiembro.id },
        data: { status: 'ACTIVE', role: 'MEMBER', joinedAt: ahora, leftAt: null },
      });
    } else {
      await tx.sharedMember.create({ data: { groupId, userId, role: 'MEMBER', joinedAt: ahora } });
    }

    await tx.sharedInvitation.update({
      where: { id: actual.id },
      data: { status: 'ACCEPTED', acceptedById: userId, acceptedAt: ahora },
    });

    const usuario = await tx.user.findUnique({ where: { id: userId }, select: { pendingInviteCode: true, name: true } });
    if (usuario?.pendingInviteCode) {
      await tx.user.update({ where: { id: userId }, data: { pendingInviteCode: null } });
    }
    return { yaEraMiembro: false, nombre: usuario?.name };
  }, { maxWait: 10000, timeout: 15000 });

  if (esMeta) {
    if (!resultado.yaEraMiembro) {
      await avisar(
        inv.group.ownerId,
        'SHARED_INVITE_ACCEPTED',
        '🤝 Ya comparten la meta',
        `${primerNombre(resultado.nombre)} entró a "${await nombreDelGrupo(groupId)}". Ahora también puede aportar.`,
        { groupId, screen: 'Goals' },
      );
    }
    return { groupId, kind: 'GOAL' as const, budgetId: null, goalId: inv.group.goalId, yaEraMiembro: resultado.yaEraMiembro };
  }

  if (!resultado.yaEraMiembro) {
    await recalcularGrupoCompartido(groupId);
    const budget = await presupuestoVigente(groupId);
    await avisar(
      inv.group.ownerId,
      'SHARED_INVITE_ACCEPTED',
      '🤝 Ya comparten el presupuesto',
      `${primerNombre(resultado.nombre)} entró a "${budget?.name ?? 'tu presupuesto'}". Desde hoy sus gastos de esa categoría suman ahí.`,
      { groupId, screen: 'Budgets' },
    );
  }

  const budget = await presupuestoVigente(groupId);
  return { groupId, kind: 'BUDGET' as const, budgetId: budget?.id ?? null, goalId: null, yaEraMiembro: resultado.yaEraMiembro };
}

// ─── Código escrito al registrarse ────────────────────────────────────────────

/**
 * Guarda el código que la persona escribió al registrarse. No acepta nada: el
 * registro no inicia sesión, y aceptar exige ver el acuerdo. Queda pendiente
 * para la primera vez que entre. Sirve además para medir: si el código es
 * válido, se anota quién la invitó.
 *
 * Nunca lanza: un código malo no puede tumbar un registro.
 */
export async function registrarCodigoDeRegistro(userId: string, codigo: string | undefined | null): Promise<boolean> {
  const code = normalizarCodigo(codigo || '');
  if (!code) return false;
  try {
    const inv = await prisma.sharedInvitation.findUnique({ where: { code }, select: { inviterId: true, status: true, expiresAt: true } });
    if (!inv || inv.status !== 'PENDING' || inv.expiresAt < new Date()) return false;
    await prisma.user.update({
      where: { id: userId },
      data: { pendingInviteCode: code, invitedByUserId: inv.inviterId },
    });
    return true;
  } catch (error) {
    logger.error('[Shared] Error guardando código de invitación del registro:', error);
    return false;
  }
}

export async function invitacionPendiente(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { pendingInviteCode: true } });
  if (!user?.pendingInviteCode) return null;
  try {
    const vista = await verInvitacion(user.pendingInviteCode, userId);
    if (vista.estado !== 'valida' || vista.yaEsMiembro) {
      await prisma.user.update({ where: { id: userId }, data: { pendingInviteCode: null } });
      return null;
    }
    return vista;
  } catch {
    await prisma.user.update({ where: { id: userId }, data: { pendingInviteCode: null } });
    return null;
  }
}

export async function descartarInvitacionPendiente(userId: string) {
  await prisma.user.update({ where: { id: userId }, data: { pendingInviteCode: null } });
}

// ─── Salir, quitar, dejar de compartir ────────────────────────────────────────

export async function nombreDelGrupo(groupId: string) {
  const grupo = await prisma.sharedGroup.findUnique({
    where: { id: groupId },
    select: { kind: true, goal: { select: { name: true } } },
  });
  if (grupo?.kind === 'GOAL') return grupo.goal?.name ?? 'la meta compartida';
  return (await presupuestoVigente(groupId))?.name ?? 'el presupuesto compartido';
}

export async function salirDeCompartido(groupId: string, userId: string) {
  const miembro = await prisma.sharedMember.findUnique({
    where: { groupId_userId: { groupId, userId } },
    include: { group: { select: { ownerId: true, kind: true, goalId: true } }, user: { select: { name: true } } },
  });
  if (!miembro || miembro.status !== 'ACTIVE') throw new SharedError(404, 'NOT_MEMBER', 'No estás en este compartido.');
  const esMeta = miembro.group.kind === 'GOAL';
  if (miembro.role === 'OWNER') {
    throw new SharedError(400, 'OWNER_CANNOT_LEAVE',
      `Eres quien comparte ${esMeta ? 'esta meta' : 'este presupuesto'}. Si ya no quieres compartirlo, deja de compartirlo.`);
  }

  await prisma.sharedMember.update({ where: { id: miembro.id }, data: { status: 'LEFT', leftAt: new Date() } });
  const nombreUsuario = primerNombre(miembro.user?.name);
  const nombre = await nombreDelGrupo(groupId);

  if (esMeta) {
    // Sus aportes se quedan en la meta (opción por defecto); el dueño puede
    // quitarlos y quien sale puede pasarlos a una meta personal.
    const aportado = await aportadoEnMeta(miembro.group.goalId, userId);
    await avisar(
      miembro.group.ownerId,
      'SHARED_STATUS',
      'Alguien salió de la meta',
      aportado > 0
        ? `${nombreUsuario} salió de "${nombre}". Sus aportes siguen en la meta; si prefieres, puedes quitarlos desde la meta.`
        : `${nombreUsuario} salió de "${nombre}".`,
      { groupId, screen: 'Goals' },
    );
    return { aportado, puedeConvertir: aportado > 0 };
  }

  await recalcularGrupoCompartido(groupId);
  await avisar(
    miembro.group.ownerId,
    'SHARED_STATUS',
    'Alguien salió del compartido',
    `${nombreUsuario} salió de "${nombre}". Sus gastos ya no suman ahí.`,
    { groupId, screen: 'Budgets' },
  );
  return { aportado: 0, puedeConvertir: false };
}

/** Lo que una persona tiene aportado (y contado) en una meta. */
export async function aportadoEnMeta(goalId: string | null, userId: string): Promise<number> {
  if (!goalId) return 0;
  const suma = await prisma.goalContribution.aggregate({
    where: { goalId, userId, excludedAt: null },
    _sum: { amount: true },
  });
  return Math.round((Number(suma._sum.amount) || 0) * 100) / 100;
}

export async function quitarMiembro(groupId: string, ownerId: string, memberUserId: string) {
  const grupo = await prisma.sharedGroup.findFirst({ where: { id: groupId, ownerId, endedAt: null } });
  if (!grupo) throw new SharedError(404, 'NOT_FOUND', 'No encontramos ese compartido.');
  if (memberUserId === ownerId) throw new SharedError(400, 'OWNER_CANNOT_LEAVE', 'No puedes quitarte a ti. Si ya no quieres compartirlo, deja de compartirlo.');

  const miembro = await prisma.sharedMember.findUnique({ where: { groupId_userId: { groupId, userId: memberUserId } } });
  if (!miembro || miembro.status !== 'ACTIVE') throw new SharedError(404, 'NOT_MEMBER', 'Esa persona ya no está en el compartido.');

  await prisma.sharedMember.update({ where: { id: miembro.id }, data: { status: 'REMOVED', leftAt: new Date() } });
  const nombre = await nombreDelGrupo(groupId);

  if (grupo.kind === 'GOAL') {
    const aportado = await aportadoEnMeta(grupo.goalId, memberUserId);
    await avisar(
      memberUserId,
      'SHARED_STATUS',
      'Ya no compartes una meta',
      aportado > 0
        ? `Ya no estás en "${nombre}". Puedes pasar lo que aportaste a una meta personal desde tus metas.`
        : `Ya no estás en "${nombre}".`,
      { groupId, screen: 'Goals' },
    );
    return;
  }

  await recalcularGrupoCompartido(groupId);
  await avisar(
    memberUserId,
    'SHARED_STATUS',
    'Ya no compartes un presupuesto',
    `Ya no estás en "${nombre}". Tus gastos siguen en tu historial.`,
    { groupId, screen: 'Budgets' },
  );
}

/**
 * Cierra el compartido: todos salen, las invitaciones pendientes dejan de
 * valer y el presupuesto vuelve a ser solo del dueño. `motivo` cambia el aviso.
 */
export async function dejarDeCompartir(
  groupId: string,
  ownerId: string,
  motivo: 'owner' | 'deleted' = 'owner',
  /** Presupuesto que provoca el cierre (al desactivarlo ya no está activo). */
  budgetIdQueCierra?: string,
) {
  const grupo = await prisma.sharedGroup.findFirst({ where: { id: groupId, ownerId } });
  if (!grupo) throw new SharedError(404, 'NOT_FOUND', 'No encontramos ese compartido.');
  if (grupo.endedAt) return;

  const nombre = await nombreDelGrupo(groupId);
  const miembros = await prisma.sharedMember.findMany({
    where: { groupId, status: 'ACTIVE', role: 'MEMBER' },
    select: { userId: true },
  });
  const ahora = new Date();
  // Un grupo cerrado no queda "en pausa": si la meta se vuelve a compartir, el
  // grupo se reabre activo. La pausa que tuviera pasa al historial.
  const cierreDePausa = grupo.pausedAt
    ? { pausedAt: null, pauseReason: null, pauseHistory: historialAlCerrarPausa(grupo, ahora) }
    : {};

  if (grupo.kind === 'GOAL') {
    // La meta no se toca: los aportes de todos se quedan (opción por defecto).
    // El grupo queda cerrado pero ligado a la meta; si se vuelve a compartir,
    // se reabre el mismo (goalId es único).
    await prisma.$transaction([
      prisma.sharedGroup.update({ where: { id: groupId }, data: { endedAt: ahora, ...cierreDePausa } }),
      prisma.sharedMember.updateMany({ where: { groupId, status: 'ACTIVE', role: 'MEMBER' }, data: { status: 'REMOVED', leftAt: ahora } }),
      prisma.sharedInvitation.updateMany({ where: { groupId, status: 'PENDING' }, data: { status: 'REVOKED' } }),
    ]);
    for (const m of miembros) {
      const aportado = await aportadoEnMeta(grupo.goalId, m.userId);
      await avisar(
        m.userId,
        'SHARED_STATUS',
        'Ya no compartes una meta',
        (motivo === 'deleted' ? `Se borró "${nombre}".` : `"${nombre}" se dejó de compartir.`) +
          (aportado > 0 ? ' Puedes pasar lo que aportaste a una meta personal desde tus metas.' : ''),
        { groupId, screen: 'Goals' },
      );
    }
    // Si había uno pausado esperando lugar, entra ya (no en unos segundos: en
    // ese hueco el dueño podía compartir otro y quedaba pausado al instante).
    await reconciliarCompartidosSeguro(ownerId);
    return;
  }

  await prisma.$transaction([
    prisma.sharedGroup.update({ where: { id: groupId }, data: { endedAt: ahora, ...cierreDePausa } }),
    prisma.sharedMember.updateMany({ where: { groupId, status: 'ACTIVE', role: 'MEMBER' }, data: { status: 'REMOVED', leftAt: ahora } }),
    prisma.sharedInvitation.updateMany({ where: { groupId, status: 'PENDING' }, data: { status: 'REVOKED' } }),
    // Suelta el período VIGENTE para que pueda volver a compartirse (con otro
    // grupo). Los cerrados se quedan en el grupo: así su acumulado sigue
    // contando lo que aportó cada uno mientras estuvo.
    //
    // La fila que provoca el cierre también se suelta aunque ya esté inactiva
    // (se acaba de desactivar): si no, quedaría con un acumulado que incluye a
    // miembros que ya no están, y al vencer volvería a sumarlos.
    prisma.budget.updateMany({
      where: {
        shared_group_id: groupId,
        OR: [{ is_active: true }, ...(budgetIdQueCierra ? [{ id: budgetIdQueCierra }] : [])],
      },
      data: { shared_group_id: null },
    }),
  ]);

  if (budgetIdQueCierra) {
    const fila = await prisma.budget.findUnique({ where: { id: budgetIdQueCierra } });
    if (fila && !fila.is_active) {
      const acumulado = await calcularAcumulado(prisma, fila);
      if (acumulado !== (Number(fila.spent) || 0)) {
        await prisma.budget.update({ where: { id: fila.id }, data: { spent: acumulado } });
      }
    }
  }

  // El presupuesto del dueño vuelve a sumar solo lo suyo.
  const vigentes = await prisma.budget.findMany({
    where: { user_id: ownerId, category_id: grupo.categoryId ?? undefined, is_active: true },
    select: { category_id: true, start_date: true },
  });
  for (const b of vigentes) await recalculateBudgets(ownerId, b.category_id, b.start_date, { notify: false });

  for (const m of miembros) {
    await avisar(
      m.userId,
      'SHARED_STATUS',
      'Ya no compartes un presupuesto',
      motivo === 'deleted'
        ? `Se borró "${nombre}". Tus gastos siguen en tu historial.`
        : `"${nombre}" se dejó de compartir. Tus gastos siguen en tu historial.`,
      { groupId, screen: 'Budgets' },
    );
  }
  await reconciliarCompartidosSeguro(ownerId);
}

/**
 * Antes de borrar un presupuesto: si es el vigente de un compartido, el
 * compartido se cierra y se avisa a los miembros. Best-effort.
 */
export async function alBorrarPresupuesto(budget: { id: string; user_id: string; shared_group_id: string | null }) {
  if (!budget.shared_group_id) return;
  try {
    const otros = await prisma.budget.count({
      where: { shared_group_id: budget.shared_group_id, is_active: true, id: { not: budget.id } },
    });
    if (otros === 0) await dejarDeCompartir(budget.shared_group_id, budget.user_id, 'deleted', budget.id);
  } catch (error) {
    logger.error(`[Shared] Error cerrando el compartido del presupuesto ${budget.id}:`, error);
  }
}

// ─── Lo que ve cada uno ───────────────────────────────────────────────────────

/** Info de compartido para los presupuestos propios en GET /budgets. */
export async function infoCompartidoDePropios(groupIds: string[]) {
  if (groupIds.length === 0) return new Map<string, { groupId: string; miembros: number; pausado: boolean }>();
  const grupos = await prisma.sharedGroup.findMany({
    where: { id: { in: groupIds }, endedAt: null },
    select: { id: true, pausedAt: true, _count: { select: { members: { where: { status: 'ACTIVE' } } } } },
  });
  return new Map(grupos.map((g) => [g.id, { groupId: g.id, miembros: g._count.members, pausado: !!g.pausedAt }]));
}

/**
 * Presupuestos que OTROS comparten conmigo. Va aparte de GET /budgets a
 * propósito: las apps viejas cuentan esa lista para el límite del plan y
 * mostrarían como propios presupuestos que no pueden editar.
 */
export async function compartidosConmigo(userId: string) {
  const membresias = await prisma.sharedMember.findMany({
    where: { userId, role: 'MEMBER', status: 'ACTIVE', group: { kind: 'BUDGET', endedAt: null } },
    select: {
      groupId: true,
      joinedAt: true,
      group: { select: { pausedAt: true, owner: { select: { name: true, currency: true } }, _count: { select: { members: { where: { status: 'ACTIVE' } } } } } },
    },
  });

  const resultado = [];
  for (const m of membresias) {
    const dueno = primerNombre(m.group.owner?.name);
    // Los montos van en la moneda del dueño: la app la necesita para el símbolo.
    const moneda = m.group.owner?.currency || '';
    if (m.group.pausedAt) {
      // Nadie se encuentra una pantalla vacía: el compartido sigue apareciendo,
      // con el porqué.
      resultado.push({
        pausado: true,
        groupId: m.groupId,
        dueno,
        mensaje: `${dueno} cambió de plan y esto quedó en pausa. Tus gastos siguen en tu historial.`,
        budget: null,
      });
      continue;
    }
    const budget = await presupuestoVigente(m.groupId);
    if (!budget) continue;
    resultado.push({
      pausado: false,
      groupId: m.groupId,
      dueno,
      moneda,
      miembros: m.group._count.members,
      budget: {
        ...budget,
        amount: Number(budget.amount),
        spent: Number(budget.spent || 0),
        alert_percentage: budget.alert_percentage ? Number(budget.alert_percentage) : null,
      },
    });
  }
  return resultado;
}

/**
 * Detalle de un presupuesto compartido para el dueño o un miembro: cuánto lleva
 * cada uno y cada gasto. Los automáticos sin confirmar de OTROS van sin
 * comercio ni nota, solo el monto.
 */
export async function detallePresupuestoCompartido(budgetId: string, viewerId: string) {
  const ref = await prisma.budget.findUnique({ where: { id: budgetId }, select: { shared_group_id: true, user_id: true } });
  if (!ref?.shared_group_id) throw new SharedError(404, 'NOT_SHARED', 'Ese presupuesto no está compartido.');
  const groupId = ref.shared_group_id;

  const grupo = await prisma.sharedGroup.findUnique({
    where: { id: groupId },
    select: { ownerId: true, pausedAt: true, endedAt: true, owner: { select: { name: true } } },
  });
  const yo = await prisma.sharedMember.findUnique({ where: { groupId_userId: { groupId, userId: viewerId } } });
  if (!grupo || grupo.endedAt || !yo || yo.status !== 'ACTIVE') {
    throw new SharedError(404, 'NOT_MEMBER', 'No estás en este presupuesto compartido.');
  }
  const soyDueno = grupo.ownerId === viewerId;
  const nombreDueno = primerNombre(grupo.owner?.name);

  if (grupo.pausedAt && !soyDueno) {
    return { pausado: true, groupId, mensaje: `${nombreDueno} cambió de plan y esto quedó en pausa. Tus gastos siguen en tu historial.` };
  }

  // El período que se pidió, si es del grupo; si no, el vigente. Un miembro no
  // abre períodos que terminaron antes de que entrara: ahí no tiene nada y
  // vería el detalle de gastos del dueño que nunca compartió con él.
  let budget = await prisma.budget.findFirst({
    where: { id: budgetId, shared_group_id: groupId },
    include: { category: { select: { id: true, name: true, icon: true, type: true, isDefault: true } } },
  });
  if (budget && !soyDueno && budget.end_date < yo.joinedAt) budget = null;
  budget = budget ?? (await presupuestoVigente(groupId));
  if (!budget) throw new SharedError(404, 'NOT_FOUND', 'No encontramos el presupuesto.');

  const { aportantes, monedaDueno } = await aportantesDePresupuesto(prisma, budget);
  const miembros = await prisma.sharedMember.findMany({
    where: { groupId, status: 'ACTIVE' },
    select: { userId: true, role: true, joinedAt: true, user: { select: { name: true, currency: true } } },
    orderBy: { joinedAt: 'asc' },
  });

  const transacciones = await prisma.transaction.findMany({
    where: {
      userId: { in: aportantes.map((a) => a.userId) },
      category_id: budget.category_id,
      type: budget.type,
      date: { gte: budget.start_date, lte: budget.end_date },
      sharedOptOut: false,
    },
    select: { id: true, userId: true, amount: true, date: true, description: true, source: true, sharedConfirmedAt: true },
    orderBy: [{ date: 'desc' }, { id: 'desc' }],
  });

  const desdePorUsuario = new Map(aportantes.map((a) => [a.userId, a]));
  const deCorreo = await idsDeCorreo(transacciones.map((t) => t.id));
  const nombres = new Map(miembros.map((m) => [m.userId, primerNombre(m.user?.name)]));

  // Mismo conversor que el acumulado: lo de cada miembro en la moneda del dueño.
  const convertir = crearConversor();

  const porMiembro = new Map<string, number>();
  const gastos = [];
  for (const t of transacciones) {
    const aportante = desdePorUsuario.get(t.userId);
    if (!aportante || !dentroDeVentana(aportante, t.date)) continue;

    const esDelDueno = t.userId === budget.user_id;
    const monto = esDelDueno
      ? Number(t.amount)
      : await convertir(Number(t.amount), t.source === 'EMAIL' ? 'DOP' : aportante.moneda, monedaDueno);
    porMiembro.set(t.userId, (porMiembro.get(t.userId) || 0) + monto);

    const mio = t.userId === viewerId;
    const pendiente = porConfirmar(t, deCorreo);
    gastos.push({
      id: t.id,
      userId: t.userId,
      miembro: nombres.get(t.userId) ?? 'Alguien',
      monto,
      fecha: t.date,
      // Lo propio siempre se ve completo. Lo de otros, sin detalle hasta que lo
      // confirme quien lo hizo.
      descripcion: mio || !pendiente ? t.description : null,
      porConfirmar: pendiente,
      mio,
    });
  }

  return {
    pausado: !!grupo.pausedAt,
    groupId,
    soyDueno,
    dueno: { id: grupo.ownerId, nombre: nombreDueno },
    moneda: monedaDueno,
    budget: {
      id: budget.id,
      name: budget.name,
      amount: Number(budget.amount),
      spent: Number(budget.spent || 0),
      period: budget.period,
      start_date: budget.start_date,
      end_date: budget.end_date,
      category: budget.category,
    },
    miembros: miembros.map((m) => ({
      userId: m.userId,
      nombre: primerNombre(m.user?.name),
      rol: m.role,
      desde: m.joinedAt,
      aportado: Math.round((porMiembro.get(m.userId) || 0) * 100) / 100,
    })),
    gastos,
  };
}

// ─── Gastos automáticos por confirmar ─────────────────────────────────────────

/**
 * Mis gastos automáticos que cuentan en un compartido (como dueño o miembro) y
 * que los demás todavía ven solo por el monto.
 */
export async function porConfirmarDe(userId: string) {
  const membresias = await prisma.sharedMember.findMany({
    where: { userId, status: 'ACTIVE', group: { kind: 'BUDGET', endedAt: null, pausedAt: null } },
    select: { groupId: true, joinedAt: true, role: true },
  });
  if (membresias.length === 0) return [];

  const resultado = [];
  for (const m of membresias) {
    const budget = await presupuestoVigente(m.groupId);
    if (!budget) continue;
    // ¿Hay alguien más? Si el dueño quedó solo, no hay a quién ocultarle nada.
    const otros = await prisma.sharedMember.count({ where: { groupId: m.groupId, status: 'ACTIVE', userId: { not: userId } } });
    if (otros === 0) continue;

    // Misma ventana que el acumulado (día LOCAL de entrada). Si no, un gasto
    // que sí cuenta —y que los demás ven enmascarado— no aparecería aquí y
    // nunca podría confirmarse.
    const { aportantes } = await aportantesDePresupuesto(prisma, budget);
    const yo = aportantes.find((a) => a.userId === userId);
    if (!yo) continue;
    const candidatas = await prisma.transaction.findMany({
      where: {
        userId,
        category_id: budget.category_id,
        type: budget.type,
        date: { gte: yo.desde ?? budget.start_date, lte: budget.end_date },
        sharedOptOut: false,
        sharedConfirmedAt: null,
      },
      select: { id: true, amount: true, date: true, description: true, source: true, sharedConfirmedAt: true },
      orderBy: { date: 'desc' },
    });
    const deCorreo = await idsDeCorreo(candidatas.map((t) => t.id));
    for (const t of candidatas) {
      if (!dentroDeVentana(yo, t.date)) continue; // gastado durante una pausa: no cuenta
      if (!porConfirmar(t, deCorreo)) continue;
      resultado.push({
        id: t.id,
        monto: Number(t.amount),
        fecha: t.date,
        descripcion: t.description,
        presupuesto: { id: budget.id, name: budget.name, groupId: m.groupId },
      });
    }
  }
  return resultado;
}

/**
 * Tras una sincronización del correo: si entraron gastos que cuentan en un
 * compartido y esperan confirmación, un solo aviso a quien los hizo. Sin esto,
 * los demás ven "RD$X por confirmar" y nadie le dice al autor que lo revise.
 */
export async function avisarGastosPorConfirmar(userId: string, desde: Date): Promise<void> {
  try {
    const pendientes = await porConfirmarDe(userId);
    if (pendientes.length === 0) return;
    const nuevos = await prisma.transaction.findMany({
      where: { id: { in: pendientes.map((p) => p.id) }, createdAt: { gte: desde } },
      select: { id: true },
    });
    if (nuevos.length === 0) return;
    const ids = new Set(nuevos.map((t) => t.id));
    const presupuestos = [...new Set(pendientes.filter((p) => ids.has(p.id)).map((p) => p.presupuesto.name))];
    const donde = presupuestos.length === 1 ? `"${presupuestos[0]}"` : 'tus compartidos';
    await avisar(
      userId,
      'SHARED_ACTIVITY',
      nuevos.length === 1 ? 'Tienes un gasto por confirmar' : `Tienes ${nuevos.length} gastos por confirmar`,
      nuevos.length === 1
        ? `Entró solo por el correo en ${donde}. Los demás solo ven el monto hasta que lo confirmes.`
        : `Entraron solos por el correo en ${donde}. Los demás solo ven el monto hasta que los confirmes.`,
      { screen: 'SharedPending' },
    );
  } catch (error) {
    logger.error(`[Shared] Error avisando gastos por confirmar a ${userId}:`, error);
  }
}

/**
 * Lo que el dueño tiene compartido y con quién. Para la pantalla de vencimiento
 * del trial ("María deja de ver 'Súper casa'") y para la de suscripción.
 */
export async function resumenDeDueno(ownerId: string) {
  const grupos = await prisma.sharedGroup.findMany({
    where: { ownerId, endedAt: null },
    orderBy: [{ sharedAt: 'asc' }, { createdAt: 'asc' }],
    select: {
      id: true,
      kind: true,
      pausedAt: true,
      members: { where: { status: 'ACTIVE', role: 'MEMBER' }, select: { user: { select: { name: true } } } },
    },
  });
  const resultado = [];
  for (const g of grupos) {
    resultado.push({
      groupId: g.id,
      tipo: g.kind === 'GOAL' ? 'meta' : 'presupuesto',
      nombre: await nombreDelGrupo(g.id),
      pausado: !!g.pausedAt,
      miembros: g.members.map((m) => primerNombre(m.user?.name)),
    });
  }
  return resultado;
}

async function transaccionPropia(transactionId: string, userId: string) {
  const t = await prisma.transaction.findFirst({ where: { id: transactionId, userId } });
  if (!t) throw new SharedError(404, 'NOT_FOUND', 'No encontramos ese gasto.');
  return t;
}

/** "Sí, va en el compartido": los demás ya ven el detalle. */
export async function confirmarGasto(transactionId: string, userId: string) {
  await transaccionPropia(transactionId, userId);
  await prisma.transaction.update({ where: { id: transactionId }, data: { sharedConfirmedAt: new Date() } });
}

/** "Este es personal": deja de contar en el compartido (no en lo personal). */
export async function sacarDelCompartido(transactionId: string, userId: string) {
  const t = await transaccionPropia(transactionId, userId);
  // No se marca como confirmado: si después lo vuelve a contar, un gasto
  // automático sigue viéndose solo por el monto hasta que lo confirme.
  await prisma.transaction.update({ where: { id: transactionId }, data: { sharedOptOut: true } });
  await recalculateBudgets(userId, t.category_id, t.date, { notify: false });
}

/** Deshace lo anterior: vuelve a contar en el compartido. */
export async function volverAContar(transactionId: string, userId: string) {
  const t = await transaccionPropia(transactionId, userId);
  if (!t.sharedOptOut) return;
  await prisma.transaction.update({ where: { id: transactionId }, data: { sharedOptOut: false } });
  await recalculateBudgets(userId, t.category_id, t.date, { notify: false });
}

/**
 * Compartido en el que cuenta un gasto de esta persona en esta categoría, si lo
 * hay. Lo usan el formulario de transacción y Zenio para decir "Contado en
 * 'Súper casa' (compartido)".
 */
/**
 * `transactionId` (opcional, al editar un gasto): dice además si ESE gasto
 * propio sigue "por confirmar", para que el formulario ofrezca confirmarlo en
 * vez de mostrar el interruptor como si ya estuviera confirmado.
 */
export async function compartidoDeCategoria(userId: string, categoryId: string, transactionId?: string) {
  const m = await prisma.sharedMember.findFirst({
    where: { userId, status: 'ACTIVE', group: { kind: 'BUDGET', categoryId, endedAt: null, pausedAt: null } },
    select: { groupId: true },
  });
  if (!m) return null;
  const otros = await prisma.sharedMember.count({ where: { groupId: m.groupId, status: 'ACTIVE', userId: { not: userId } } });
  if (otros === 0) return null; // el dueño solo, sin nadie más: no es "compartido" todavía
  const budget = await presupuestoVigente(m.groupId);
  if (!budget) return null;

  // Misma fuente que la lista de "por confirmar": así la ventana (período y
  // día de entrada) es idéntica. Un gasto viejo de esa categoría no lo ve
  // nadie, y decirle "los demás solo ven el monto" sería falso.
  let gastoPorConfirmar = false;
  if (transactionId) {
    const pendientes = await porConfirmarDe(userId);
    gastoPorConfirmar = pendientes.some((p) => p.id === transactionId && p.presupuesto.groupId === m.groupId);
  }
  return { groupId: m.groupId, budgetId: budget.id, name: budget.name, gastoPorConfirmar };
}
