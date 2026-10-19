import { prisma } from '../lib/prisma';
import { logger } from '../utils/logger';
import { NotificationService } from './notificationService';
import { subscriptionService } from './subscriptionService';
import { crearConversor } from './budgetService';
import {
  SharedError,
  avisar,
  aportadoEnMeta,
  dejarDeCompartir,
  generarCodigo,
  lock,
  primerNombre,
} from './sharedService';
import {
  isSharedEnabled,
  SHARED_INVITE_TTL_DAYS,
  SHARED_MAX_MEMBERS,
  sharedInviteLink,
} from '../config/shared';

/**
 * Metas compartidas (2026-10). Grupos, miembros e invitaciones son los mismos
 * que los de presupuestos (sharedService.ts); aquí va lo propio de las metas.
 *
 * Reglas (v2 + decisiones del 2026-10-16):
 *   - Comparte el dueño con Plus (1 meta) o Pro (ilimitadas).
 *   - Todos aportan; cada aporte queda con el nombre de quien lo hizo.
 *   - Solo el dueño edita, borra o cambia el monto/fecha. Retirar dinero no
 *     existe todavía (tampoco en metas personales).
 *   - Si alguien sale, sus aportes se QUEDAN en la meta (por defecto); el dueño
 *     puede quitarlos del total, y quien sale puede pasarlos a una meta
 *     personal. Las dos cosas a la vez están permitidas: FinZen no guarda
 *     dinero, lo aportado sigue en la cuenta de cada quien.
 *
 * `Goal.currentAmount` sigue siendo el total que leen las apps. Los aportes
 * (GoalContribution) dicen de quién es cada parte; la suma de los no excluidos
 * debe dar `currentAmount`. Las metas anteriores a 2026-10 no tienen aportes:
 * se les crea un "aporte inicial" del dueño la primera vez que hace falta.
 */

const includeCategoria = { category: { select: { id: true, name: true, icon: true, type: true } } } as const;

/**
 * Cuadra los aportes con `currentAmount`: lo que falte se le atribuye al dueño
 * (metas de antes de que existieran los aportes, o aportes hechos por caminos
 * que no los registraban). Va dentro de la transacción del llamador.
 */
async function cuadrarAportes(tx: any, goal: { id: string; userId: string; currentAmount: number; createdAt: Date; lastContributionDate: Date | null }) {
  const suma = await tx.goalContribution.aggregate({ where: { goalId: goal.id, excludedAt: null }, _sum: { amount: true } });
  const diferencia = Math.round((Number(goal.currentAmount) - (Number(suma._sum.amount) || 0)) * 100) / 100;
  if (diferencia > 0) {
    await tx.goalContribution.create({
      data: {
        goalId: goal.id,
        userId: goal.userId,
        amount: diferencia,
        createdAt: goal.lastContributionDate ?? goal.createdAt,
      },
    });
  }
}

/** Grupo vigente (no cerrado) de una meta, si está compartida. */
async function grupoDeMeta(goalId: string) {
  return prisma.sharedGroup.findFirst({
    where: { goalId, kind: 'GOAL', endedAt: null },
    select: { id: true, ownerId: true, pausedAt: true },
  });
}

// ─── Invitar ──────────────────────────────────────────────────────────────────

export async function invitarAMeta(ownerId: string, goalId: string) {
  if (!isSharedEnabled(ownerId)) {
    throw new SharedError(403, 'FEATURE_DISABLED', 'Compartir metas todavía no está disponible para tu cuenta.');
  }

  const goal = await prisma.goal.findFirst({
    where: { id: goalId, userId: ownerId },
    include: { user: { select: { name: true } } },
  });
  if (!goal || !goal.isActive) throw new SharedError(404, 'NOT_FOUND', 'No encontramos esa meta.');
  if (goal.isCompleted) throw new SharedError(400, 'GOAL_COMPLETED', 'Esta meta ya se cumplió.');

  // Lock por dueño: igual que en presupuestos, dos toques seguidos o varias
  // metas a la vez no pueden crear grupos de más ni pasar del límite.
  const groupId: string = await prisma.$transaction(async (tx) => {
    await lock(tx, `sharedowner:${ownerId}`);

    const existente = await tx.sharedGroup.findUnique({ where: { goalId: goal.id } });
    if (existente && !existente.endedAt) {
      if (existente.pausedAt) {
        throw new SharedError(409, 'SHARED_PAUSED',
          'Esta meta compartida está en pausa porque tu plan cambió. Mejora tu plan para reactivarla.', { upgrade: true });
      }
      return existente.id; // ya está compartida: solo otra invitación
    }

    const sub = await subscriptionService.getUserSubscription(ownerId);
    const limite = Number((sub.limits as any).sharedGoals ?? 0);
    if (limite !== -1) {
      // Los pausados cuentan (ver invitarAPresupuesto).
      const actuales = await tx.sharedGroup.count({ where: { ownerId, kind: 'GOAL', endedAt: null } });
      if (actuales >= limite) {
        throw new SharedError(
          403,
          'SHARED_LIMIT',
          limite === 0
            ? 'Compartir metas es parte de Plus y Pro.'
            : `Tu plan permite compartir hasta ${limite} ${limite === 1 ? 'meta' : 'metas'}, contando las que están en pausa. Deja de compartir una o mejora tu plan.`,
          { upgrade: true, limitType: 'sharedGoals', limit: limite, current: actuales, currentPlan: sub.plan },
        );
      }
    }

    // A partir de aquí cada parte del total tiene dueño.
    await cuadrarAportes(tx, goal);

    if (existente) {
      // Se había dejado de compartir: se reabre el mismo grupo (goalId es único).
      await tx.sharedGroup.update({ where: { id: existente.id }, data: { endedAt: null, pausedAt: null, pauseReason: null, sharedAt: new Date() } });
      await tx.sharedMember.upsert({
        where: { groupId_userId: { groupId: existente.id, userId: ownerId } },
        update: { status: 'ACTIVE', role: 'OWNER', leftAt: null },
        create: { groupId: existente.id, userId: ownerId, role: 'OWNER' },
      });
      return existente.id;
    }

    const nuevo = await tx.sharedGroup.create({
      data: {
        kind: 'GOAL',
        ownerId,
        categoryId: goal.categoryId,
        goalId: goal.id,
        members: { create: { userId: ownerId, role: 'OWNER' } },
      },
    });
    return nuevo.id;
  }, { maxWait: 10000, timeout: 15000 });

  const activos = await prisma.sharedMember.count({ where: { groupId, status: 'ACTIVE' } });
  if (activos >= SHARED_MAX_MEMBERS) {
    throw new SharedError(409, 'GROUP_FULL', `Una meta compartida admite hasta ${SHARED_MAX_MEMBERS} personas, contándote a ti.`);
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
  return {
    code: invitacion.code,
    link,
    expiresAt: invitacion.expiresAt,
    groupId,
    mensaje:
      `${primerNombre(goal.user?.name)} te invita a ahorrar juntos para "${goal.name}" en FinZen. ` +
      `Abre el enlace: ${link}\n` +
      `Si todavía no tienes FinZen, descárgalo y escribe el código ${invitacion.code} al registrarte.`,
  };
}

// ─── Aportar ──────────────────────────────────────────────────────────────────

/**
 * Aporte a una meta propia o compartida. Reemplaza al update directo que hacía
 * POST /goals/:id/contribute: ese leía el total, sumaba y escribía en dos pasos,
 * y dos aportes a la vez se pisaban (con dos personas aportando, pasa).
 */
export async function aportarAMeta(goalId: string, userId: string, monto: number) {
  if (!(monto > 0)) throw new SharedError(400, 'INVALID_AMOUNT', 'El monto debe ser mayor a 0');

  const resultado = await prisma.$transaction(async (tx) => {
    await lock(tx, `goal:${goalId}`);

    const goal = await tx.goal.findUnique({ where: { id: goalId } });
    if (!goal || !goal.isActive) throw new SharedError(404, 'NOT_FOUND', 'Meta no encontrada');

    const esDueno = goal.userId === userId;
    let groupId: string | null = null;
    if (!esDueno) {
      // No es suya: tiene que ser miembro activo de la meta compartida.
      const miembro = await tx.sharedMember.findFirst({
        where: { userId, status: 'ACTIVE', group: { goalId, kind: 'GOAL', endedAt: null } },
        select: { groupId: true, group: { select: { pausedAt: true } } },
      });
      if (!miembro) throw new SharedError(404, 'NOT_FOUND', 'Meta no encontrada');
      if (miembro.group.pausedAt) throw new SharedError(409, 'SHARED_PAUSED', 'Esta meta compartida está en pausa por ahora.');
      groupId = miembro.groupId;
    } else {
      const grupo = await tx.sharedGroup.findFirst({ where: { goalId, kind: 'GOAL', endedAt: null, pausedAt: null }, select: { id: true } });
      groupId = grupo?.id ?? null;
    }

    // Si quien aporta usa otra moneda que el dueño, se guarda convertido a la
    // del dueño: la meta tiene una sola moneda.
    let montoMeta = monto;
    if (!esDueno) {
      const [yo, dueno] = await Promise.all([
        tx.user.findUnique({ where: { id: userId }, select: { currency: true } }),
        tx.user.findUnique({ where: { id: goal.userId }, select: { currency: true } }),
      ]);
      montoMeta = await crearConversor()(monto, yo?.currency || '', dueno?.currency || '');
    }

    const nuevoTotal = Math.round((Number(goal.currentAmount) + montoMeta) * 100) / 100;
    if (nuevoTotal > Number(goal.targetAmount) + 0.005) {
      // Mismo texto de siempre: la app ya lo muestra tal cual.
      throw new SharedError(400, 'EXCEEDS_TARGET', 'La contribución excedería el monto objetivo de la meta');
    }
    const completada = nuevoTotal >= Number(goal.targetAmount) - 0.005;

    await cuadrarAportes(tx, goal);
    await tx.goalContribution.create({ data: { goalId, userId, amount: montoMeta } });

    const actualizada = await tx.goal.update({
      where: { id: goalId },
      data: {
        currentAmount: nuevoTotal,
        contributionsCount: { increment: 1 },
        lastContributionDate: new Date(),
        isCompleted: completada,
      },
      include: includeCategoria,
    });

    return { goal: actualizada, recienCompletada: completada && !goal.isCompleted, groupId, montoMeta };
  }, { maxWait: 10000, timeout: 15000 });

  // Avisos, fuera de la transacción y sin poder romper el aporte.
  try {
    const { goal, recienCompletada, groupId, montoMeta } = resultado;
    const miembros = groupId
      ? (await prisma.sharedMember.findMany({ where: { groupId, status: 'ACTIVE' }, select: { userId: true } })).map((m) => m.userId)
      : [];

    if (miembros.length > 1) {
      const [quien, dueno] = await Promise.all([
        prisma.user.findUnique({ where: { id: userId }, select: { name: true } }),
        prisma.user.findUnique({ where: { id: goal.userId }, select: { currency: true } }),
      ]);
      const moneda = dueno?.currency || 'RD$';
      for (const otro of miembros.filter((m) => m !== userId)) {
        await avisar(
          otro,
          'SHARED_ACTIVITY',
          '💰 Nuevo aporte a la meta',
          `${primerNombre(quien?.name)} aportó ${moneda} ${montoMeta.toLocaleString('es-DO', { maximumFractionDigits: 2 })} a "${goal.name}".`,
          { groupId: groupId!, goalId: goal.id, screen: 'Goals' },
        );
      }
    }

    if (recienCompletada) {
      const destinatarios = miembros.length > 1 ? miembros : [goal.userId];
      for (const d of destinatarios) {
        await NotificationService.notifyGoalAchieved(d, goal.name);
      }
    }
  } catch (error) {
    logger.error('[SharedGoals] Error avisando del aporte:', error);
  }

  return resultado.goal;
}

// ─── Lo que ve cada uno ───────────────────────────────────────────────────────

/** Info de compartido para las metas propias en GET /goals. */
export async function infoCompartidoDeMetas(goalIds: string[]) {
  if (goalIds.length === 0) return new Map<string, { groupId: string; miembros: number; pausado: boolean }>();
  const grupos = await prisma.sharedGroup.findMany({
    where: { goalId: { in: goalIds }, kind: 'GOAL', endedAt: null },
    select: { id: true, goalId: true, pausedAt: true, _count: { select: { members: { where: { status: 'ACTIVE' } } } } },
  });
  return new Map(grupos.map((g) => [g.goalId!, { groupId: g.id, miembros: g._count.members, pausado: !!g.pausedAt }]));
}

/**
 * Metas que OTROS comparten conmigo, aparte de GET /goals por la misma razón
 * que los presupuestos: las apps viejas cuentan esa lista para el límite.
 */
export async function metasCompartidasConmigo(userId: string) {
  const membresias = await prisma.sharedMember.findMany({
    where: { userId, role: 'MEMBER', status: 'ACTIVE', group: { kind: 'GOAL', endedAt: null } },
    select: {
      groupId: true,
      group: {
        select: {
          pausedAt: true,
          goalId: true,
          owner: { select: { name: true } },
          _count: { select: { members: { where: { status: 'ACTIVE' } } } },
        },
      },
    },
  });

  const resultado = [];
  for (const m of membresias) {
    const dueno = primerNombre(m.group.owner?.name);
    if (m.group.pausedAt) {
      resultado.push({
        pausado: true,
        groupId: m.groupId,
        dueno,
        mensaje: `${dueno} cambió de plan y esto quedó en pausa. Lo que aportaste sigue registrado.`,
        goal: null,
      });
      continue;
    }
    const goal = m.group.goalId
      ? await prisma.goal.findFirst({ where: { id: m.group.goalId, isActive: true }, include: includeCategoria })
      : null;
    if (!goal) continue;
    resultado.push({
      pausado: false,
      groupId: m.groupId,
      dueno,
      miembros: m.group._count.members,
      miAporte: await aportadoEnMeta(goal.id, userId),
      goal,
    });
  }
  return resultado;
}

/**
 * Detalle de una meta compartida: cuánto puso cada uno y los aportes. Para el
 * dueño incluye a quienes salieron y siguen contando, para que decida si los
 * conserva o los quita.
 */
export async function detalleMetaCompartida(goalId: string, viewerId: string) {
  const grupo = await prisma.sharedGroup.findFirst({
    where: { goalId, kind: 'GOAL', endedAt: null },
    select: { id: true, ownerId: true, pausedAt: true, owner: { select: { name: true, currency: true } } },
  });
  const yo = grupo
    ? await prisma.sharedMember.findUnique({ where: { groupId_userId: { groupId: grupo.id, userId: viewerId } } })
    : null;
  if (!grupo || !yo || yo.status !== 'ACTIVE') throw new SharedError(404, 'NOT_MEMBER', 'No estás en esta meta compartida.');

  const soyDueno = grupo.ownerId === viewerId;
  const nombreDueno = primerNombre(grupo.owner?.name);
  if (grupo.pausedAt && !soyDueno) {
    return { pausado: true, groupId: grupo.id, mensaje: `${nombreDueno} cambió de plan y esto quedó en pausa. Lo que aportaste sigue registrado.` };
  }

  const goal = await prisma.goal.findFirst({ where: { id: goalId, isActive: true }, include: includeCategoria });
  if (!goal) throw new SharedError(404, 'NOT_FOUND', 'Meta no encontrada');

  // Metas viejas: que todo el total tenga dueño antes de repartirlo.
  await prisma.$transaction(async (tx) => {
    await lock(tx, `goal:${goalId}`);
    const fresca = await tx.goal.findUnique({ where: { id: goalId } });
    if (fresca) await cuadrarAportes(tx, fresca);
  });

  const [miembros, aportes] = await Promise.all([
    prisma.sharedMember.findMany({
      where: { groupId: grupo.id },
      select: { userId: true, role: true, status: true, joinedAt: true, user: { select: { name: true } } },
      orderBy: { joinedAt: 'asc' },
    }),
    prisma.goalContribution.findMany({
      where: { goalId, excludedAt: null },
      select: { id: true, userId: true, amount: true, createdAt: true, user: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
    }),
  ]);

  const porPersona = new Map<string, number>();
  for (const a of aportes) porPersona.set(a.userId, (porPersona.get(a.userId) || 0) + Number(a.amount));
  const redondear = (n: number) => Math.round(n * 100) / 100;

  return {
    pausado: !!grupo.pausedAt,
    groupId: grupo.id,
    soyDueno,
    dueno: { id: grupo.ownerId, nombre: nombreDueno },
    moneda: grupo.owner?.currency || '',
    goal,
    miembros: miembros
      .filter((m) => m.status === 'ACTIVE')
      .map((m) => ({
        userId: m.userId,
        nombre: primerNombre(m.user?.name),
        rol: m.role,
        desde: m.joinedAt,
        aportado: redondear(porPersona.get(m.userId) || 0),
      })),
    // Salieron, pero lo que aportaron sigue en el total. Solo lo ve el dueño:
    // es quien decide si se queda o se quita.
    exMiembros: soyDueno
      ? miembros
          .filter((m) => m.status !== 'ACTIVE' && (porPersona.get(m.userId) || 0) > 0)
          .map((m) => ({ userId: m.userId, nombre: primerNombre(m.user?.name), aportado: redondear(porPersona.get(m.userId) || 0) }))
      : [],
    aportes: aportes.slice(0, 100).map((a) => ({
      id: a.id,
      userId: a.userId,
      nombre: primerNombre(a.user?.name),
      monto: Number(a.amount),
      fecha: a.createdAt,
      mio: a.userId === viewerId,
    })),
  };
}

// ─── Después de salir ─────────────────────────────────────────────────────────

/**
 * El dueño quita del total lo que aportó alguien que ya salió. No borra nada:
 * marca esos aportes como excluidos (quien salió los puede seguir pasando a una
 * meta personal).
 */
export async function quitarAportesDeExMiembro(goalId: string, ownerId: string, exMiembroId: string) {
  return prisma.$transaction(async (tx) => {
    await lock(tx, `goal:${goalId}`);
    const goal = await tx.goal.findFirst({ where: { id: goalId, userId: ownerId, isActive: true } });
    if (!goal) throw new SharedError(404, 'NOT_FOUND', 'Meta no encontrada');
    if (exMiembroId === ownerId) throw new SharedError(400, 'OWN_CONTRIBUTIONS', 'Tus propios aportes no se pueden quitar así.');

    const miembro = await tx.sharedMember.findFirst({
      where: { userId: exMiembroId, group: { goalId, kind: 'GOAL' } },
      select: { status: true },
    });
    if (!miembro) throw new SharedError(404, 'NOT_MEMBER', 'Esa persona no estuvo en esta meta.');
    if (miembro.status === 'ACTIVE') {
      throw new SharedError(409, 'STILL_MEMBER', 'Esa persona sigue en la meta. Sus aportes solo se pueden quitar cuando salga.');
    }

    const suma = await tx.goalContribution.aggregate({ where: { goalId, userId: exMiembroId, excludedAt: null }, _sum: { amount: true } });
    const quitado = Math.round((Number(suma._sum.amount) || 0) * 100) / 100;
    if (quitado <= 0) return { quitado: 0, goal: await tx.goal.findUnique({ where: { id: goalId }, include: includeCategoria }) };

    await tx.goalContribution.updateMany({ where: { goalId, userId: exMiembroId, excludedAt: null }, data: { excludedAt: new Date() } });
    const nuevoTotal = Math.max(0, Math.round((Number(goal.currentAmount) - quitado) * 100) / 100);
    const actualizada = await tx.goal.update({
      where: { id: goalId },
      data: { currentAmount: nuevoTotal, isCompleted: nuevoTotal >= Number(goal.targetAmount) - 0.005 },
      include: includeCategoria,
    });
    return { quitado, goal: actualizada };
  }, { maxWait: 10000, timeout: 15000 });
}

/**
 * Quien salió de una meta compartida pasa lo que aportó a una meta personal
 * nueva, con el mismo nombre y objetivo. Cuenta para su límite de metas como
 * cualquier otra.
 *
 * Se convierten solo los aportes que todavía no se habían convertido
 * (`convertedAt`): si la persona convierte, vuelve a entrar, aporta más y sale
 * otra vez, puede convertir lo nuevo sin duplicar lo ya convertido.
 */
export async function convertirAportesEnMetaPersonal(groupId: string, userId: string) {
  const miembro = await prisma.sharedMember.findUnique({
    where: { groupId_userId: { groupId, userId } },
    include: { group: { select: { kind: true, goalId: true } } },
  });
  if (!miembro || miembro.group.kind !== 'GOAL' || !miembro.group.goalId) {
    throw new SharedError(404, 'NOT_MEMBER', 'No estuviste en esa meta.');
  }
  if (miembro.status === 'ACTIVE') throw new SharedError(409, 'STILL_MEMBER', 'Sigues en esta meta. Primero sal de ella.');

  const original = await prisma.goal.findUnique({ where: { id: miembro.group.goalId } });
  if (!original) throw new SharedError(404, 'NOT_FOUND', 'Meta no encontrada');
  const goalId = original.id;

  const [yo, dueno] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { currency: true } }),
    prisma.user.findUnique({ where: { id: original.userId }, select: { currency: true } }),
  ]);
  const sub = await subscriptionService.getUserSubscription(userId);
  const limite = Number((sub.limits as any).goals ?? -1);
  const convertir = crearConversor();

  return prisma.$transaction(async (tx) => {
    // Lock por PERSONA: dos toques no crean dos metas, y convertir desde dos
    // metas a la vez no se salta el límite de metas del plan.
    await lock(tx, `sharedconvert:${userId}`);

    // Lo que aportó y no ha convertido, esté o no contado todavía en la meta del
    // dueño (quitarlo del total no le quita el derecho a su registro).
    const pendientes = await tx.goalContribution.findMany({
      where: { goalId, userId, convertedAt: null },
      select: { id: true, amount: true },
    });
    const enMonedaDueno = Math.round(pendientes.reduce((s: number, a: { amount: number }) => s + Number(a.amount), 0) * 100) / 100;
    if (enMonedaDueno <= 0) {
      const yaConvertido = await tx.goalContribution.count({ where: { goalId, userId, convertedAt: { not: null } } });
      throw yaConvertido > 0
        ? new SharedError(409, 'ALREADY_CONVERTED', 'Ya pasaste tus aportes a una meta personal.')
        : new SharedError(400, 'NOTHING_TO_CONVERT', 'No tienes aportes en esa meta.');
    }

    // Límite de metas del plan de quien sale (mismo criterio que checkGoalLimit).
    if (limite !== -1) {
      const actuales = await tx.goal.count({ where: { userId, isActive: true } });
      if (actuales >= limite) {
        throw new SharedError(403, 'GOAL_LIMIT', `Tu plan permite hasta ${limite} metas. Mejora tu plan para guardar esta.`,
          { upgrade: true, limitType: 'goals', limit: limite, current: actuales, currentPlan: sub.plan });
      }
    }

    // Los aportes se guardaron en la moneda del dueño; la meta nueva va en la suya.
    const aportado = await convertir(enMonedaDueno, dueno?.currency || '', yo?.currency || '');
    const objetivo = Math.max(aportado, await convertir(Number(original.targetAmount), dueno?.currency || '', yo?.currency || ''));

    const nueva = await tx.goal.create({
      data: {
        userId,
        name: original.name,
        description: original.description,
        targetAmount: objetivo,
        currentAmount: aportado,
        targetDate: original.targetDate,
        categoryId: original.categoryId,
        priority: 'medium',
        monthlyTargetPercentage: original.monthlyTargetPercentage,
        monthlyContributionAmount: original.monthlyContributionAmount,
        contributionsCount: 1,
        lastContributionDate: new Date(),
        isCompleted: aportado >= objetivo,
        contributions: { create: { userId, amount: aportado } },
      },
      include: includeCategoria,
    });
    await tx.goalContribution.updateMany({
      where: { id: { in: pendientes.map((a: { id: string }) => a.id) } },
      data: { convertedAt: new Date() },
    });
    await tx.sharedMember.update({ where: { id: miembro.id }, data: { convertedGoalId: nueva.id } });
    return nueva;
  }, { maxWait: 10000, timeout: 15000 });
}

/**
 * Metas compartidas de las que salí con aportes que todavía puedo pasar a una
 * meta personal. Para el botón "Convertir mis RD$X en una meta personal".
 */
export async function aportesConvertibles(userId: string) {
  const membresias = await prisma.sharedMember.findMany({
    where: { userId, role: 'MEMBER', status: { in: ['LEFT', 'REMOVED'] }, group: { kind: 'GOAL' } },
    select: { groupId: true, group: { select: { goalId: true, goal: { select: { name: true } } } } },
  });
  const resultado = [];
  for (const m of membresias) {
    if (!m.group.goalId) continue;
    const suma = await prisma.goalContribution.aggregate({
      where: { goalId: m.group.goalId, userId, convertedAt: null },
      _sum: { amount: true },
    });
    const aportado = Math.round((Number(suma._sum.amount) || 0) * 100) / 100;
    if (aportado > 0) resultado.push({ groupId: m.groupId, meta: m.group.goal?.name ?? 'Meta', aportado });
  }
  return resultado;
}

/** Al borrar una meta compartida: se cierra el compartido y se avisa. Best-effort. */
export async function alBorrarMeta(goal: { id: string; userId: string }) {
  try {
    const grupo = await grupoDeMeta(goal.id);
    if (grupo) await dejarDeCompartir(grupo.id, goal.userId, 'deleted');
  } catch (error) {
    logger.error(`[SharedGoals] Error cerrando el compartido de la meta ${goal.id}:`, error);
  }
}
