import { RecurrenceFrequency, TransactionType } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { createTransactionCore } from '../controllers/transactions';
import { NotificationService } from './notificationService';
import { getTimezoneByCountry } from '../utils/timezone';
import { RECURRING_CONFIG } from '../config/recurringConfig';
import { logger } from '../utils/logger';

// ─────────────────────────────────────────────────────────────────────────
// GASTOS / INGRESOS RECURRENTES
//
// Reglas de frecuencia (definidas con el socio, 2026-07-26):
//   WEEKLY   → cada 7 días, mismo día de la semana que la transacción original
//   BIWEEKLY → día 15 y último día del mes ("la quincena"). FIJO: no depende
//              de cuándo se creó la regla.
//   MONTHLY  → mismo día del mes que la original (+1 mes). Si ese día no
//              existe en el mes destino (31 en febrero) cae al último día.
//
// Todas las fechas se manejan normalizadas a MEDIANOCHE UTC. Eso las convierte
// en "días de calendario" puros y hace que el índice único
// [recurringId, date] funcione como llave de idempotencia real.
// ─────────────────────────────────────────────────────────────────────────

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Normaliza cualquier fecha a medianoche UTC (día de calendario puro). */
export function toUtcMidnight(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/**
 * Convierte un día de calendario a la hora con la que se GUARDA una
 * transacción: mediodía UTC.
 *
 * No es un detalle cosmético. La app manda las transacciones manuales a las
 * 12:00 UTC precisamente para esto (ver TransactionForm: "Enviar como mediodía
 * UTC para evitar problemas de zona horaria"). Si el cron las guardara a
 * medianoche UTC, en República Dominicana (UTC-4) el 15 de agosto a las 00:00Z
 * es el 14 de agosto a las 8 PM: cualquier cálculo que pase la fecha a hora
 * local — agrupar por mes en un reporte, un corte de presupuesto — la contaría
 * en el día (y a veces el MES) anterior. El mediodía deja margen de ±12h, que
 * cubre todos los husos donde opera la app.
 */
export function toTransactionDate(day: Date): Date {
  return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 12, 0, 0));
}

/** Último día del mes al que pertenece `date` (1-31). */
function lastDayOfMonth(year: number, month: number): number {
  // El día 0 del mes siguiente es el último del mes actual.
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/**
 * Suma `months` meses a una fecha conservando el día, y si el mes destino no
 * tiene ese día, cae al último. Se calcula SIEMPRE desde el ancla original
 * (startDate), nunca desde la última ocurrencia: si se encadenara, un 31 de
 * enero se degradaría a 28 en febrero y ya nunca volvería a caer 31.
 */
function addMonthsClamped(anchor: Date, months: number): Date {
  const year = anchor.getUTCFullYear();
  const month = anchor.getUTCMonth() + months;
  const targetYear = year + Math.floor(month / 12);
  const targetMonth = ((month % 12) + 12) % 12;
  const day = Math.min(anchor.getUTCDate(), lastDayOfMonth(targetYear, targetMonth));
  return new Date(Date.UTC(targetYear, targetMonth, day));
}

/**
 * Devuelve la primera fecha programada ESTRICTAMENTE POSTERIOR a `after`.
 *
 * Al calcularse siempre contra el ancla (`startDate`) y no de forma
 * incremental, la función es idempotente y auto-corrige: si el cron no corrió
 * durante una semana, sigue devolviendo exactamente las fechas que
 * correspondían, sin desfase acumulado.
 */
export function nextOccurrence(
  frequency: RecurrenceFrequency,
  startDate: Date,
  after: Date
): Date {
  const start = toUtcMidnight(startDate);
  // Nunca calculamos hacia atrás del ancla.
  const from = toUtcMidnight(after) < start ? start : toUtcMidnight(after);

  switch (frequency) {
    case 'WEEKLY': {
      const daysSinceStart = Math.floor((from.getTime() - start.getTime()) / MS_PER_DAY);
      const periods = Math.floor(daysSinceStart / 7) + 1;
      return new Date(start.getTime() + periods * 7 * MS_PER_DAY);
    }

    case 'BIWEEKLY': {
      // El 15 y el último día del mes. No usa el ancla a propósito: "la
      // quincena" son esos dos días del calendario, caiga cuando caiga la
      // transacción que originó la regla.
      const year = from.getUTCFullYear();
      const month = from.getUTCMonth();
      const day = from.getUTCDate();
      const lastDay = lastDayOfMonth(year, month);

      if (day < 15) return new Date(Date.UTC(year, month, 15));
      if (day < lastDay) return new Date(Date.UTC(year, month, lastDay));
      // Ya estamos en el último día del mes → toca el 15 del mes siguiente.
      return new Date(Date.UTC(year, month + 1, 15));
    }

    case 'MONTHLY': {
      // Arrancamos por la diferencia de meses y ajustamos: el clamp de fin de
      // mes puede hacer que el candidato caiga en o antes de `from`.
      let months =
        (from.getUTCFullYear() - start.getUTCFullYear()) * 12 +
        (from.getUTCMonth() - start.getUTCMonth());
      let candidate = addMonthsClamped(start, months);
      while (candidate.getTime() <= from.getTime()) {
        months += 1;
        candidate = addMonthsClamped(start, months);
      }
      return candidate;
    }

    default: {
      // Frecuencia desconocida: comportarse como mensual antes que romper.
      return addMonthsClamped(start, 1);
    }
  }
}

/**
 * El día de calendario en el que está parado el usuario AHORA, según su país,
 * expresado como medianoche UTC para poder compararlo con `nextRunDate`.
 */
export function localToday(country: string | null | undefined): Date {
  const timeZone = getTimezoneByCountry(country);
  try {
    // en-CA da formato ISO (YYYY-MM-DD), que es justo lo que necesitamos.
    const ymd = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    return new Date(`${ymd}T00:00:00.000Z`);
  } catch {
    return toUtcMidnight(new Date());
  }
}

/** Hora local actual del usuario (0-23), según su país. */
function localHour(country: string | null | undefined): number {
  const timeZone = getTimezoneByCountry(country);
  try {
    return parseInt(
      new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hour12: false }).format(new Date()),
      10
    );
  } catch {
    return new Date().getUTCHours();
  }
}

/**
 * Descripción con la que se guarda la transacción generada. El usuario pidió
 * explícitamente que se note que fue automática.
 */
export function buildAutoDescription(
  baseDescription: string | null | undefined,
  type: TransactionType
): string {
  const suffix =
    type === 'INCOME' ? RECURRING_CONFIG.SUFFIX_INCOME : RECURRING_CONFIG.SUFFIX_EXPENSE;
  const base = baseDescription?.trim();
  return base ? `${base}${RECURRING_CONFIG.SUFFIX_SEPARATOR}${suffix}` : suffix;
}

/**
 * Crea la regla de recurrencia a partir de una transacción recién registrada.
 * `startDate` es la fecha de esa transacción: la regla arranca a generar desde
 * la SIGUIENTE ocurrencia (la de hoy ya la creó el usuario).
 */
export async function createRecurringRule(input: {
  userId: string;
  amount: number;
  type: TransactionType;
  category_id: string;
  description?: string | null;
  frequency: RecurrenceFrequency;
  startDate: Date;
}) {
  const startDate = toUtcMidnight(input.startDate);

  // El ancla puede estar en el PASADO: el date picker de la app permite
  // registrar una transacción con fecha vieja, y ahí marcar "repetir".
  // Sin este clamp, una regla anclada en enero creada en julio le dispararía
  // al usuario 6 movimientos retroactivos en el primer tick del cron —
  // moviéndole el balance y reescribiendo reportes de meses ya cerrados.
  // Se conserva `startDate` como ancla (para que MONTHLY mantenga el día del
  // mes) pero se empieza a generar desde hoy hacia adelante.
  const today = toUtcMidnight(new Date());
  const generateFrom = startDate.getTime() > today.getTime() ? startDate : today;
  const nextRunDate = nextOccurrence(input.frequency, startDate, generateFrom);

  return prisma.recurringTransaction.create({
    data: {
      userId: input.userId,
      amount: input.amount,
      type: input.type,
      category_id: input.category_id,
      description: input.description ?? null,
      frequency: input.frequency,
      startDate,
      nextRunDate,
    },
  });
}

/**
 * Ejecuta una regla: genera todas las transacciones que le deban al día de hoy
 * (normalmente una) y deja `nextRunDate` apuntando a la siguiente.
 */
async function runRule(
  rule: {
    id: string;
    userId: string;
    amount: number;
    type: TransactionType;
    description: string | null;
    category_id: string;
    frequency: RecurrenceFrequency;
    startDate: Date;
    nextRunDate: Date;
  },
  today: Date
): Promise<number> {
  const maxCatchup = RECURRING_CONFIG.MAX_CATCHUP_PER_RUN;
  let cursor = toUtcMidnight(rule.nextRunDate);
  let created = 0;

  while (cursor.getTime() <= today.getTime() && created < maxCatchup) {
    try {
      await createTransactionCore({
        userId: rule.userId,
        amount: rule.amount,
        type: rule.type,
        category_id: rule.category_id,
        description: buildAutoDescription(rule.description, rule.type),
        // Mediodía UTC, igual que las manuales (ver toTransactionDate).
        date: toTransactionDate(cursor),
        recurringId: rule.id,
        // Es el cron, no el usuario: no cuenta para racha, FinScore ni H13.
        engagementHooks: false,
      });
      created++;
    } catch (error: any) {
      if (error?.code === 'P2002') {
        // Ya existía una transacción de esta regla para ese día. Normalmente es
        // el índice único haciendo su trabajo (reinicio del server, dos
        // instancias). Pero también salta si el usuario EDITÓ una transacción
        // generada y le puso la fecha de una ocurrencia futura: ahí la del cron
        // no se crea y no es un duplicado. Por eso va como error y no como log:
        // en producción solo se ven los logger.error.
        logger.error(
          `[Recurring] Regla ${rule.id}: ya existía una transacción para ${cursor.toISOString().slice(0, 10)}, se omite`
        );
      } else {
        throw error;
      }
    }

    // Guarda de monotonía: `nextOccurrence` DEBE avanzar. Si por un bug (o una
    // frecuencia nueva sin case propio) devolviera una fecha igual o anterior,
    // este while giraría para siempre pegándole a la BD — el `created <
    // maxCatchup` no acota nada cuando los create fallan con P2002.
    const advanced = nextOccurrence(rule.frequency, rule.startDate, cursor);
    if (advanced.getTime() <= cursor.getTime()) {
      logger.error(
        `[Recurring] Regla ${rule.id}: la frecuencia "${rule.frequency}" no avanzó desde ${cursor.toISOString().slice(0, 10)}. Se corta para no entrar en bucle.`
      );
      break;
    }
    cursor = advanced;
  }

  if (created >= maxCatchup && cursor.getTime() <= today.getTime()) {
    logger.error(
      `[Recurring] Regla ${rule.id} topó el límite de ${maxCatchup} ocurrencias por corrida. Continúa mañana desde ${cursor.toISOString().slice(0, 10)}`
    );
  }

  await prisma.recurringTransaction.update({
    where: { id: rule.id },
    data: { nextRunDate: cursor, lastRunAt: new Date() },
  });

  return created;
}

/**
 * Cuerpo del cron. Procesa las reglas vencidas de los usuarios cuya hora local
 * sea RUN_LOCAL_HOUR (por eso el scheduler corre cada hora y no una vez al día:
 * así cada usuario recibe su transacción a una hora razonable de SU huso).
 *
 * @param options.ignoreLocalHour salta el filtro de hora (uso manual / testing)
 */
export async function runDueRecurringTransactions(
  options: { ignoreLocalHour?: boolean } = {}
): Promise<{ rulesProcessed: number; transactionsCreated: number }> {
  const { ignoreLocalHour = false } = options;

  if (!RECURRING_CONFIG.ENABLED) {
    return { rulesProcessed: 0, transactionsCreated: 0 };
  }

  // Traemos con holgura (+1 día) para no depender del huso del server al filtrar;
  // el corte real por usuario se hace abajo contra SU día local.
  const upperBound = new Date(toUtcMidnight(new Date()).getTime() + MS_PER_DAY);

  const dueRules = await prisma.recurringTransaction.findMany({
    where: {
      isActive: true,
      nextRunDate: { lte: upperBound },
    },
    include: {
      user: { select: { id: true, country: true } },
    },
  });

  if (dueRules.length === 0) {
    return { rulesProcessed: 0, transactionsCreated: 0 };
  }

  let rulesProcessed = 0;
  let transactionsCreated = 0;
  // Para notificar una sola vez por usuario aunque tenga varias reglas.
  const createdByUser = new Map<string, number>();

  for (const rule of dueRules) {
    try {
      // `>=` y no `===`: con igualdad estricta, cada usuario tiene UN solo tick
      // de oportunidad al día, y como el backend auto-deploya en cada push a
      // main, un redeploy justo a esa hora dejaba a todos sin sus recurrentes
      // ese día (node-cron no reejecuta ticks perdidos). Con `>=`, cualquier
      // tick posterior del mismo día lo recupera; no se duplica nada porque
      // runRule deja `nextRunDate` en el futuro y el chequeo de abajo corta.
      if (!ignoreLocalHour && localHour(rule.user.country) < RECURRING_CONFIG.RUN_LOCAL_HOUR) {
        continue;
      }

      const today = localToday(rule.user.country);
      if (toUtcMidnight(rule.nextRunDate).getTime() > today.getTime()) {
        continue; // todavía no le toca en SU calendario
      }

      const created = await runRule(rule, today);
      rulesProcessed++;
      transactionsCreated += created;
      if (created > 0) {
        createdByUser.set(rule.userId, (createdByUser.get(rule.userId) ?? 0) + created);
      }
    } catch (error) {
      // Una regla rota no puede tumbar al resto.
      logger.error(`[Recurring] Error procesando regla ${rule.id}:`, error);
    }
  }

  if (RECURRING_CONFIG.NOTIFY_ENABLED) {
    for (const [userId, count] of createdByUser) {
      try {
        await NotificationService.notifyRecurringTransactions(userId, count);
      } catch (error) {
        logger.error(`[Recurring] Error notificando a ${userId}:`, error);
      }
    }
  }

  if (transactionsCreated > 0) {
    logger.log(
      `[Recurring] ✅ ${transactionsCreated} transacciones generadas desde ${rulesProcessed} reglas`
    );
  }

  return { rulesProcessed, transactionsCreated };
}
