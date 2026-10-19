import { prisma } from '../lib/prisma';
import { logger } from '../utils/logger';
import {
  SharedError,
  confirmarGasto,
  detallePresupuestoCompartido,
  invitarAPresupuesto,
  nombreDelGrupo,
  porConfirmarDe,
  primerNombre,
  sacarDelCompartido,
  volverAContar,
} from './sharedService';
import { aportarAMeta, detalleMetaCompartida, invitarAMeta } from './sharedGoalService';

/**
 * Lo compartido, visto por Zenio (F4).
 *
 * Regla de privacidad que no depende del modelo: aquí solo se arma lo que ENTRÓ
 * al compartido (gastos de esa categoría que cuentan, aportes a esa meta). De
 * los demás miembros Zenio nunca recibe otras categorías, metas personales,
 * ingresos ni saldo — no los puede revelar porque no los tiene. Los gastos
 * automáticos sin confirmar de otros llegan solo con el monto.
 *
 * Todo sale ya en español y sin ids internos: es lo que lee el modelo.
 */

const LIMITE_GASTOS_RECIENTES = 8;

/** Va en el resultado de la herramienta: el modelo sigue mejor lo que viene ahí. */
const INSTRUCCION_INVITACION =
  'La invitación YA está creada. Entrégale AHORA al usuario el mensajeParaEnviar (tal cual, para copiar y mandar por WhatsApp) y el código. No pidas confirmación.';

function dinero(monto: number, moneda: string): string {
  const n = Math.round(Number(monto) * 100) / 100;
  const txt = n.toLocaleString('es-DO', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  return !moneda || moneda === 'DOP' ? `RD$${txt}` : `${moneda} ${txt}`;
}

function fechaCorta(fecha: Date | string | null | undefined): string | null {
  if (!fecha) return null;
  return new Date(fecha).toISOString().split('T')[0];
}

function normalizar(s: string): string {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

export interface PresupuestoCompartidoZenio {
  tipo: 'presupuesto';
  nombre: string;
  categoria?: string;
  dueno: string; // "tú" o el primer nombre
  puedesEditar: boolean;
  con: string[]; // los OTROS miembros
  pausado: boolean;
  nota?: string;
  moneda?: string;
  asignado?: number;
  gastadoTotal?: number;
  disponible?: number;
  porcentajeUso?: number;
  cierra?: string | null;
  diasRestantes?: number;
  porPersona?: { nombre: string; gastado: number }[];
  gastosRecientes?: { quien: string; monto: number; fecha: string | null; descripcion: string }[];
}

export interface MetaCompartidaZenio {
  tipo: 'meta';
  nombre: string;
  dueno: string;
  puedesEditar: boolean;
  con: string[];
  pausado: boolean;
  nota?: string;
  moneda?: string;
  objetivo?: number;
  actual?: number;
  progreso?: number;
  completada?: boolean;
  fechaLimite?: string | null;
  porPersona?: { nombre: string; aportado: number }[];
  tuAporte?: number;
}

export interface CompartidosZenio {
  presupuestos: PresupuestoCompartidoZenio[];
  metas: MetaCompartidaZenio[];
  porConfirmar: number;
  porConfirmarDetalle?: { monto: number; fecha: string | null; descripcion: string | null; presupuesto?: string }[];
}

/** Grupos abiertos en los que está el usuario (dueño o miembro activo). */
async function misGrupos(userId: string) {
  return prisma.sharedMember.findMany({
    where: { userId, status: 'ACTIVE', group: { endedAt: null } },
    select: {
      role: true,
      group: {
        select: {
          id: true,
          kind: true,
          ownerId: true,
          goalId: true,
          pausedAt: true,
          owner: { select: { name: true } },
          members: { where: { status: 'ACTIVE' }, select: { userId: true, user: { select: { name: true } } } },
        },
      },
    },
  });
}

/** ¿El usuario está en algún compartido abierto? Barato: decide si se arma el resto. */
export async function tieneCompartidos(userId: string): Promise<boolean> {
  const n = await prisma.sharedMember.count({
    where: {
      userId,
      status: 'ACTIVE',
      group: { endedAt: null },
      // Un dueño solo (invitó pero nadie aceptó aún) también cuenta: puede
      // preguntar por la invitación.
    },
  });
  return n > 0;
}

/** Todo lo compartido del usuario, saneado para el modelo. */
export async function compartidosParaZenio(userId: string): Promise<CompartidosZenio> {
  const grupos = await misGrupos(userId);
  const presupuestos: PresupuestoCompartidoZenio[] = [];
  const metas: MetaCompartidaZenio[] = [];

  for (const { group: g } of grupos) {
    const soyDueno = g.ownerId === userId;
    const dueno = soyDueno ? 'tú' : primerNombre(g.owner?.name);
    const con = g.members.filter((m) => m.userId !== userId).map((m) => primerNombre(m.user?.name));
    const nombre = await nombreDelGrupo(g.id);
    const nombreDe = (id: string, n?: string | null) => (id === userId ? 'tú' : primerNombre(n));
    const notaPausa = soyDueno
      ? 'EN PAUSA: tu plan actual no lo incluye. Los demás no lo ven y sus gastos nuevos no suman. Se reactiva solo si mejoras tu plan.'
      : `EN PAUSA: ${dueno} cambió de plan. No puedes verlo ni aportar hasta que ${dueno} lo reactive. Lo tuyo sigue en tu historial.`;

    try {
      if (g.kind === 'BUDGET') {
        if (g.pausedAt && !soyDueno) {
          presupuestos.push({ tipo: 'presupuesto', nombre, dueno, puedesEditar: false, con, pausado: true, nota: notaPausa });
          continue;
        }
        const vigente = await prisma.budget.findFirst({
          where: { shared_group_id: g.id, is_active: true },
          orderBy: { start_date: 'desc' },
          select: { id: true },
        });
        if (!vigente) continue;
        const d: any = await detallePresupuestoCompartido(vigente.id, userId);
        const b = d.budget;
        const asignado = Number(b.amount) || 0;
        const gastadoTotal = Math.round((Number(b.spent) || 0) * 100) / 100;
        const porPersona = (d.miembros ?? []).map((m: any) => ({
          nombre: nombreDe(m.userId, m.nombre),
          gastado: Number(m.aportado) || 0,
        }));
        const gastosRecientes = (d.gastos ?? []).slice(0, LIMITE_GASTOS_RECIENTES).map((t: any) => ({
          quien: t.mio ? 'tú' : t.miembro,
          monto: t.monto,
          fecha: fechaCorta(t.fecha),
          descripcion: t.descripcion ?? '(gasto automático aún sin confirmar: solo se ve el monto)',
        }));
        const fin = b.end_date ? new Date(b.end_date) : null;
        presupuestos.push({
          tipo: 'presupuesto',
          nombre: b.name ?? nombre,
          categoria: b.category?.name,
          dueno,
          puedesEditar: soyDueno,
          con,
          pausado: !!g.pausedAt,
          nota: g.pausedAt ? notaPausa : undefined,
          moneda: d.moneda,
          asignado,
          gastadoTotal,
          disponible: Math.round(Math.max(0, asignado - gastadoTotal) * 100) / 100,
          porcentajeUso: asignado > 0 ? Math.round((gastadoTotal / asignado) * 100) : 0,
          cierra: fechaCorta(fin),
          diasRestantes: fin ? Math.max(0, Math.ceil((fin.getTime() - Date.now()) / 86400000)) : undefined,
          porPersona,
          gastosRecientes,
        });
      } else if (g.goalId) {
        if (g.pausedAt && !soyDueno) {
          metas.push({ tipo: 'meta', nombre, dueno, puedesEditar: false, con, pausado: true, nota: notaPausa });
          continue;
        }
        const d: any = await detalleMetaCompartida(g.goalId, userId);
        const goal = d.goal;
        const objetivo = Number(goal.targetAmount) || 0;
        const actual = Number(goal.currentAmount) || 0;
        const porPersona = (d.miembros ?? []).map((m: any) => ({ nombre: nombreDe(m.userId, m.nombre), aportado: m.aportado }));
        // Lo de quienes salieron sigue en el total. El dueño ve quiénes; un
        // miembro solo ve el resto sin nombre (no le corresponde saber más).
        for (const ex of d.exMiembros ?? []) porPersona.push({ nombre: `${ex.nombre} (ya salió)`, aportado: ex.aportado });
        const resto = Math.round((actual - porPersona.reduce((s: number, p: any) => s + Number(p.aportado || 0), 0)) * 100) / 100;
        if (resto > 0.01) porPersona.push({ nombre: 'personas que ya salieron', aportado: resto });
        metas.push({
          tipo: 'meta',
          nombre: goal.name,
          dueno,
          puedesEditar: soyDueno,
          con,
          pausado: !!g.pausedAt,
          nota: g.pausedAt ? notaPausa : undefined,
          moneda: d.moneda,
          objetivo,
          actual,
          progreso: objetivo > 0 ? Math.round((actual / objetivo) * 100) : 0,
          completada: !!goal.isCompleted,
          fechaLimite: fechaCorta(goal.targetDate),
          porPersona,
          tuAporte: porPersona.find((p: any) => p.nombre === 'tú')?.aportado ?? 0,
        });
      }
    } catch (error) {
      // Un compartido roto no puede tumbar la conversación.
      logger.error(`[ZenioShared] Error armando el compartido ${g.id}:`, error);
    }
  }

  let porConfirmar = 0;
  let porConfirmarDetalle: { monto: number; fecha: string | null; descripcion: string | null; presupuesto?: string }[] = [];
  try {
    const lista = await porConfirmarDe(userId);
    porConfirmar = lista.length;
    // Son gastos DEL PROPIO usuario: puede ver su comercio.
    porConfirmarDetalle = lista.slice(0, 5).map((g: any) => ({ monto: g.monto, fecha: fechaCorta(g.fecha), descripcion: g.descripcion, presupuesto: g.presupuesto?.name }));
  } catch {}

  return { presupuestos, metas, porConfirmar, porConfirmarDetalle };
}

/**
 * Bloque de contexto para el prompt. Vacío si el usuario no está en ningún
 * compartido: al 99% que no comparte no le cuesta un token.
 */
export async function contextoCompartidoZenio(userId: string): Promise<string> {
  try {
    if (!(await tieneCompartidos(userId))) return '';
    const c = await compartidosParaZenio(userId);
    if (c.presupuestos.length === 0 && c.metas.length === 0) return '';

    const lineas: string[] = ['', '', 'COMPARTIDOS DEL USUARIO (datos reales de hoy; "tú" = el usuario):'];
    const quienes = (con: string[]) => (con.length ? con.join(', ') : 'nadie todavía (invitación pendiente)');
    for (const p of c.presupuestos) {
      if (p.pausado && p.asignado === undefined) {
        lineas.push(`· Presupuesto "${p.nombre}" — dueño: ${p.dueno} — ${p.nota}`);
        continue;
      }
      const m = p.moneda || 'DOP';
      const reparto = (p.porPersona ?? []).map((x) => `${x.nombre} ${dinero(x.gastado, m)}`).join(' · ');
      // Si el invitado tiene ADEMÁS uno personal de la misma categoría, Zenio
      // tiene que saberlo: "súbele el del súper" puede ser cualquiera de los dos.
      let personal = '';
      if (p.categoria) {
        const propio = await prisma.budget.findFirst({
          where: { user_id: userId, is_active: true, shared_group_id: null, category: { name: p.categoria }, end_date: { gte: new Date() } },
          select: { amount: true, spent: true },
        });
        if (propio) {
          personal = ` OJO: tú también tienes un presupuesto PERSONAL de ${p.categoria} (${dinero(Number(propio.spent) || 0, 'DOP')} de ${dinero(Number(propio.amount), 'DOP')}); ` +
            `si pide cambiar "el de ${p.categoria}", pregunta cuál y ofrece cambiar el personal.`;
        } else {
          personal = ` No tienes otro presupuesto de ${p.categoria}: si habla de "el de ${p.categoria}", es este (no preguntes cuál).`;
        }
      }
      lineas.push(
        `· Presupuesto "${p.nombre}" — categoría ${p.categoria} — dueño: ${p.dueno}` +
          `${p.puedesEditar ? '' : ' (tú NO puedes editarlo, borrarlo ni invitar a nadie)'} — con: ${quienes(p.con)} — ` +
          `${dinero(p.gastadoTotal ?? 0, m)} de ${dinero(p.asignado ?? 0, m)} (${p.porcentajeUso}%), disponible ${dinero(p.disponible ?? 0, m)}, ` +
          `cierra ${p.cierra} (${p.diasRestantes} días). Por persona: ${reparto || 'sin gastos aún'}.` +
          (p.pausado ? ` ${p.nota}` : '') + personal,
      );
    }
    for (const g of c.metas) {
      if (g.pausado && g.objetivo === undefined) {
        lineas.push(`· Meta "${g.nombre}" — dueño: ${g.dueno} — ${g.nota}`);
        continue;
      }
      const m = g.moneda || 'DOP';
      const reparto = (g.porPersona ?? []).map((x) => `${x.nombre} ${dinero(x.aportado, m)}`).join(' · ');
      lineas.push(
        `· Meta "${g.nombre}" — dueño: ${g.dueno}${g.puedesEditar ? '' : ' (tú NO puedes editarla, borrarla ni invitar a nadie; sí puedes aportar)'}` +
          ` — con: ${quienes(g.con)} — ${dinero(g.actual ?? 0, m)} de ${dinero(g.objetivo ?? 0, m)} (${g.progreso}%)` +
          `${g.completada ? ', CUMPLIDA' : ''}${g.fechaLimite ? `, fecha límite ${g.fechaLimite}` : ''}. Aportes: ${reparto || 'ninguno aún'}.` +
          (g.pausado ? ` ${g.nota}` : ''),
      );
    }
    // Línea lista para copiar en el PREVIEW de un gasto: el modelo la sigue mucho
    // mejor que una regla abstracta.
    for (const p of c.presupuestos) {
      if (p.pausado || !p.categoria) continue;
      lineas.push(`· Si registra un GASTO de ${p.categoria}, el PREVIEW DEBE incluir esta línea: "· Cuenta en «${p.nombre}» (compartido con ${p.con.join(' y ') || 'nadie aún'})"`);
    }
    if (c.porConfirmar > 0) {
      const detalle = (c.porConfirmarDetalle ?? []).map((g) => `${dinero(g.monto, 'DOP')} ${g.descripcion ?? ''} (${g.fecha}, ${g.presupuesto})`).join('; ');
      lineas.push(`· Tienes ${c.porConfirmar} gasto(s) automático(s) por confirmar en tus compartidos (los demás solo ven el monto): ${detalle}. Si pregunta, muéstraselos.`);
    }
    return lineas.join('\n');
  } catch (error) {
    logger.error(`[ZenioShared] Error armando el contexto de ${userId}:`, error);
    return '';
  }
}

/** Presupuesto compartido VIGENTE del que el usuario es MIEMBRO (no dueño) en esa categoría. */
export async function compartidoAjenoEnCategoria(userId: string, categoryId: string) {
  const m = await prisma.sharedMember.findFirst({
    where: { userId, role: 'MEMBER', status: 'ACTIVE', group: { kind: 'BUDGET', categoryId, endedAt: null } },
    select: { groupId: true, group: { select: { owner: { select: { name: true } } } } },
  });
  if (!m) return null;
  return { groupId: m.groupId, nombre: await nombreDelGrupo(m.groupId), dueno: primerNombre(m.group.owner?.name) };
}

/** Meta compartida de la que el usuario es MIEMBRO (no dueño) cuyo nombre coincide. */
export async function metaAjenaPorNombre(userId: string, texto: string) {
  const q = normalizar(texto);
  if (!q) return null;
  const ms = await prisma.sharedMember.findMany({
    where: { userId, role: 'MEMBER', status: 'ACTIVE', group: { kind: 'GOAL', endedAt: null } },
    select: { group: { select: { goal: { select: { id: true, name: true } }, owner: { select: { name: true } } } } },
  });
  const hit = ms.find((m) => m.group.goal && normalizar(m.group.goal.name).includes(q));
  return hit ? { goalId: hit.group.goal!.id, nombre: hit.group.goal!.name, dueno: primerNombre(hit.group.owner?.name) } : null;
}

// ─── Herramientas ────────────────────────────────────────────────────────────

/** Metas en las que el usuario puede aportar: las suyas activas y las compartidas con él. */
async function metasAportables(userId: string) {
  const propias = await prisma.goal.findMany({
    where: { userId, isActive: true },
    select: { id: true, name: true, isCompleted: true, targetAmount: true },
  });
  const compartidas = await prisma.sharedMember.findMany({
    where: { userId, role: 'MEMBER', status: 'ACTIVE', group: { kind: 'GOAL', endedAt: null } },
    select: { group: { select: { goal: { select: { id: true, name: true, isCompleted: true, targetAmount: true, isActive: true } } } } },
  });
  const ajenas = compartidas.map((m) => m.group.goal).filter((g): g is NonNullable<typeof g> => !!g && g.isActive);
  return [...propias, ...ajenas];
}

/** aportar_a_meta: aporte a una meta propia o compartida conmigo. */
export async function aportarDesdeZenio(args: any, userId: string) {
  const monto = parseFloat(args?.amount);
  if (!(monto > 0)) return { success: false, message: '¿Cuánto quieres aportar? El monto tiene que ser mayor que cero.' };

  const candidatas = await metasAportables(userId);
  if (candidatas.length === 0) return { success: false, message: 'No tienes metas activas para aportar. ¿Creamos una?' };

  const q = normalizar(args?.goal_name || '');
  let elegidas = q ? candidatas.filter((g) => normalizar(g.name).includes(q) || q.includes(normalizar(g.name))) : candidatas;
  if (elegidas.length === 0) {
    return { success: false, message: `No encontré una meta llamada "${args?.goal_name}". Tus metas: ${candidatas.map((g) => `"${g.name}"`).join(', ')}.` };
  }
  if (elegidas.length > 1) {
    const exactas = elegidas.filter((g) => normalizar(g.name) === q);
    if (exactas.length === 1) elegidas = exactas;
    else return { success: false, message: `¿A cuál meta? ${elegidas.map((g) => `"${g.name}"`).join(', ')}.`, action: 'clarify_goal' };
  }

  try {
    const goal: any = await aportarAMeta(elegidas[0].id, userId, monto);
    const objetivo = Number(goal.targetAmount) || 0;
    const actual = Number(goal.currentAmount) || 0;
    const grupo = await prisma.sharedGroup.findFirst({
      where: { goalId: goal.id, kind: 'GOAL', endedAt: null, pausedAt: null },
      select: { members: { where: { status: 'ACTIVE', userId: { not: userId } }, select: { user: { select: { name: true } } } } },
    });
    const otros = grupo?.members.map((m) => primerNombre(m.user?.name)) ?? [];
    return {
      success: true,
      action: 'goal_contribution',
      message:
        `Aporte registrado en "${goal.name}". Van ${actual} de ${objetivo} (${objetivo > 0 ? Math.round((actual / objetivo) * 100) : 0}%).` +
        (goal.isCompleted ? ' ¡La meta se cumplió!' : '') +
        (otros.length ? ` Se les avisó a ${otros.join(', ')}.` : ''),
      meta: { nombre: goal.name, objetivo, actual, cumplida: !!goal.isCompleted, compartidaCon: otros },
    };
  } catch (error) {
    if (error instanceof SharedError) return { success: false, message: error.message, code: error.code, ...(error.extra as any) };
    throw error;
  }
}

/** Gastos propios que coinciden con los criterios (solo del usuario: nunca toca los de otros). */
async function gastosPropios(userId: string, criterios: any) {
  const where: any = { userId, type: 'EXPENSE' };
  if (criterios?.amount) where.amount = parseFloat(criterios.amount);
  if (criterios?.category) {
    const cat = await prisma.category.findFirst({ where: { name: { equals: criterios.category, mode: 'insensitive' } } });
    if (cat) where.category_id = cat.id;
  }
  if (criterios?.date) {
    // ±1 día: según de dónde vino (correo a mediodía UTC, app, Zenio) y la zona
    // horaria, "el gasto de hoy" puede estar guardado con el día de al lado.
    const dia = new Date(criterios.date + 'T12:00:00Z');
    where.date = { gte: new Date(dia.getTime() - 36 * 3600000), lte: new Date(dia.getTime() + 36 * 3600000) };
  }
  const hits = await prisma.transaction.findMany({ where, orderBy: { date: 'desc' }, take: 5, include: { category: { select: { name: true } } } });
  if (hits.length > 1 && criterios?.date) {
    const exactos = hits.filter((t: any) => t.date.toISOString().split('T')[0] === criterios.date);
    if (exactos.length === 1) return exactos;
  }
  return hits;
}

/** manage_shared_record: lo compartido que se maneja desde el chat. */
export async function manejarCompartidoZenio(args: any, userId: string) {
  const op = args?.operation;
  try {
    switch (op) {
      case 'ver': {
        const c = await compartidosParaZenio(userId);
        return { success: true, action: 'shared_listed', ...c };
      }

      case 'por_confirmar': {
        const lista = await porConfirmarDe(userId);
        return {
          success: true,
          action: 'shared_pending_listed',
          gastos: lista.map((g: any) => ({ monto: g.monto, fecha: fechaCorta(g.fecha), descripcion: g.descripcion, presupuesto: g.presupuesto?.name })),
          count: lista.length,
        };
      }

      case 'confirmar': {
        const lista = await porConfirmarDe(userId);
        if (lista.length === 0) return { success: true, message: 'No tienes gastos por confirmar.', action: 'shared_confirmed' };
        let elegidos = lista;
        if (!args?.todos) {
          const c = args?.criterios_identificacion || {};
          elegidos = lista.filter((g: any) =>
            (!c.amount || Math.abs(Number(g.monto) - parseFloat(c.amount)) < 0.01) &&
            (!c.date || fechaCorta(g.fecha) === c.date));
          if (elegidos.length === 0) return { success: false, message: 'No encontré ese gasto entre los que tienes por confirmar.' };
          if (elegidos.length > 1) return { success: false, message: `Hay ${elegidos.length} gastos que coinciden. ¿Cuál? Dime el monto y la fecha.` };
        }
        for (const g of elegidos) await confirmarGasto(g.id, userId);
        return { success: true, action: 'shared_confirmed', message: `Confirmado(s) ${elegidos.length} gasto(s): ahora los demás ven el detalle.`, count: elegidos.length };
      }

      case 'sacar':
      case 'volver_a_contar': {
        const candidatos = await gastosPropios(userId, args?.criterios_identificacion);
        if (candidatos.length === 0) return { success: false, message: 'No encontré ese gasto entre los tuyos.' };
        if (candidatos.length > 1) return { success: false, message: `Encontré ${candidatos.length} gastos tuyos que coinciden. Dime el monto, la categoría y la fecha.` };
        const t = candidatos[0];
        if (op === 'sacar') {
          await sacarDelCompartido(t.id, userId);
          return { success: true, action: 'shared_opt_out', message: `Listo: el gasto de ${t.amount} en ${t.category?.name} ya no cuenta en el compartido. Sigue en tu historial.` };
        }
        await volverAContar(t.id, userId);
        return { success: true, action: 'shared_opt_in', message: `Listo: el gasto de ${t.amount} en ${t.category?.name} vuelve a contar en el compartido.` };
      }

      case 'invitar': {
        const tipo = args?.tipo === 'meta' ? 'meta' : 'presupuesto';
        const q = normalizar(args?.nombre || '');
        if (tipo === 'meta') {
          const metas = await prisma.goal.findMany({ where: { userId, isActive: true, isCompleted: false }, select: { id: true, name: true } });
          const hit = q ? metas.filter((g) => normalizar(g.name).includes(q)) : metas;
          if (hit.length !== 1) {
            const ajena = q ? await metaAjenaPorNombre(userId, q) : null;
            if (ajena) return { success: false, action: 'shared_owner_only', message: `"${ajena.nombre}" es de ${ajena.dueno}: solo ${ajena.dueno} puede invitar a más personas.` };
            return { success: false, message: hit.length === 0 ? 'No encontré esa meta entre las tuyas.' : `¿Cuál meta? ${hit.map((g) => `"${g.name}"`).join(', ')}.` };
          }
          const inv = await invitarAMeta(userId, hit[0].id);
          return { success: true, action: 'shared_invite_created', codigo: inv.code, enlace: inv.link, vence: fechaCorta(inv.expiresAt), mensajeParaEnviar: inv.mensaje, instruccion: INSTRUCCION_INVITACION };
        }
        const budgets = await prisma.budget.findMany({
          where: { user_id: userId, is_active: true, type: 'EXPENSE' },
          select: { id: true, name: true, category: { select: { id: true, name: true } } },
        });
        const hit = q ? budgets.filter((b) => normalizar(b.name).includes(q) || normalizar(b.category.name).includes(q)) : budgets;
        if (hit.length !== 1) {
          if (q) {
            const cat = await prisma.category.findFirst({ where: { name: { contains: args?.nombre, mode: 'insensitive' } }, select: { id: true } });
            const ajeno = cat ? await compartidoAjenoEnCategoria(userId, cat.id) : null;
            if (ajeno) return { success: false, action: 'shared_owner_only', message: `"${ajeno.nombre}" es de ${ajeno.dueno}: solo ${ajeno.dueno} puede invitar a más personas.` };
          }
          return { success: false, message: hit.length === 0 ? 'No encontré ese presupuesto entre los tuyos. Primero hay que crearlo.' : `¿Cuál presupuesto? ${hit.map((b) => `"${b.name}"`).join(', ')}.` };
        }
        const inv = await invitarAPresupuesto(userId, hit[0].id);
        return { success: true, action: 'shared_invite_created', codigo: inv.code, enlace: inv.link, vence: fechaCorta(inv.expiresAt), mensajeParaEnviar: inv.mensaje, instruccion: INSTRUCCION_INVITACION };
      }

      default:
        return { success: false, message: `Operación no soportada: ${op}` };
    }
  } catch (error) {
    if (error instanceof SharedError) {
      return { success: false, message: error.message, code: error.code, upgrade: (error.extra as any)?.upgrade ?? undefined };
    }
    throw error;
  }
}
