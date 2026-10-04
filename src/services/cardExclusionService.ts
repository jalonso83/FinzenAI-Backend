import { prisma } from '../lib/prisma';
import { recalculateBudgets } from './budgetService';
import { logger } from '../utils/logger';

/**
 * Tarjetas excluidas de Gastos en automático.
 *
 * Caso de uso: la tarjeta corporativa. El usuario no quiere que sus consumos se
 * mezclen con sus finanzas personales, así que la "apaga" y desde ese momento
 * los avisos con esa terminación no se convierten en transacción.
 *
 * La terminación sale de `ImportedBankEmail.parsedData.cardLast4`, que el parser
 * ya extrae (99,6-100% de los avisos de los bancos principales la traen, medido
 * en producción el 2026-10-04). No se guarda en la transacción, así que todo lo
 * que haya que saber de "qué consumos son de qué tarjeta" se consulta por el
 * enlace correo → transacción (`ImportedBankEmail.transactionId`).
 */

/** Motivo con el que se marca un correo omitido por tarjeta excluida. */
export const CARD_EXCLUDED_SKIPPED = 'CARD_EXCLUDED_SKIPPED';

export interface TarjetaDetectada {
  last4: string;
  bancos: string[];
  /** Consumos importados de esta tarjeta que siguen existiendo como transacción. */
  consumosImportados: number;
  ultimoConsumo: Date | null;
  excluida: boolean;
  excluidaDesde: Date | null;
}

export function esTerminacionValida(last4: unknown): last4 is string {
  return typeof last4 === 'string' && /^\d{4}$/.test(last4);
}

export class CardExclusionService {

  /** Terminaciones excluidas del usuario, para consultar en la sincronización. */
  static async getExcludedSet(userId: string): Promise<Set<string>> {
    const filas = await prisma.cardExclusion.findMany({
      where: { userId },
      select: { last4: true },
    });
    return new Set(filas.map(f => f.last4));
  }

  /**
   * Tarjetas que aparecen en los avisos de BANCO del usuario, más las que él
   * excluyó a mano aunque todavía no hayan tenido consumos.
   *
   * Solo se listan las vistas en remitentes de bancos (supported_banks): los
   * recibos de comercios (Uber, Apple…) traen la misma tarjeta y la lista
   * saldría repetida o con "bancos" que no lo son. La exclusión, en cambio, se
   * aplica a cualquier correo con esa terminación.
   */
  static async listCards(userId: string): Promise<{ tarjetas: TarjetaDetectada[]; necesitaRevision: boolean }> {
    const filas = await prisma.$queryRawUnsafe<{
      last4: string;
      bancos: string[] | null;
      consumos: bigint;
      ultimo: Date | null;
    }[]>(`
      WITH correos AS (
        SELECT e."parsedData"->>'cardLast4' AS last4,
               e."transactionId",
               e."receivedAt",
               lower(split_part(regexp_replace(COALESCE(substring(e."senderEmail" from '<([^>]+)>'), e."senderEmail"), '\\s', '', 'g'), '@', 2)) AS dominio
        FROM imported_bank_emails e
        JOIN email_connections c ON c.id = e."emailConnectionId"
        WHERE c."userId" = $1
          AND e."parsedData"->>'cardLast4' ~ '^[0-9]{4}$'
      ),
      dominios_banco AS (
        SELECT DISTINCT b.name, lower(split_part(x, '@', 2)) AS dominio
        FROM supported_banks b, unnest(b."senderEmails") x
      ),
      -- Qué tarjetas se listan y con qué banco: solo las vistas en avisos de banco.
      tarjetas_banco AS (
        SELECT co.last4, array_agg(DISTINCT db.name) AS bancos
        FROM correos co
        JOIN dominios_banco db ON db.dominio = co.dominio
        GROUP BY co.last4
      ),
      -- Cuántos consumos tiene: de CUALQUIER remitente, con el mismo criterio
      -- que usa exclude() al quitarlos. Si aquí se contara solo lo del banco,
      -- la confirmación diría "quitar 22" y se borrarían 26 (los recibos de
      -- comercios que entraron por el bug de las conexiones sin filtros).
      consumos AS (
        SELECT co.last4, COUNT(DISTINCT t.id) AS n, MAX(co."receivedAt") AS ultimo
        FROM correos co
        LEFT JOIN transactions t ON t.id = co."transactionId" AND t."userId" = $1 AND t.type = 'EXPENSE'
        GROUP BY co.last4
      )
      SELECT tb.last4, tb.bancos, c.n::bigint AS consumos, c.ultimo
      FROM tarjetas_banco tb
      JOIN consumos c ON c.last4 = tb.last4
      ORDER BY c.ultimo DESC
    `, userId);

    const [exclusiones, usuario] = await Promise.all([
      prisma.cardExclusion.findMany({ where: { userId } }),
      prisma.user.findUnique({ where: { id: userId }, select: { tarjetasRevisadasAt: true } }),
    ]);
    const excluidaDesde = new Map(exclusiones.map(e => [e.last4, e.createdAt]));

    const tarjetas: TarjetaDetectada[] = filas.map(f => ({
      last4: f.last4,
      bancos: f.bancos ?? [],
      consumosImportados: Number(f.consumos),
      ultimoConsumo: f.ultimo,
      excluida: excluidaDesde.has(f.last4),
      excluidaDesde: excluidaDesde.get(f.last4) ?? null,
    }));

    // Las agregadas a mano que todavía no aparecen en ningún aviso.
    const vistas = new Set(tarjetas.map(t => t.last4));
    for (const e of exclusiones) {
      if (!vistas.has(e.last4)) {
        tarjetas.push({
          last4: e.last4,
          bancos: [],
          consumosImportados: 0,
          ultimoConsumo: null,
          excluida: true,
          excluidaDesde: e.createdAt,
        });
      }
    }

    // La lista se le presenta UNA vez y solo si hay algo que elegir.
    const necesitaRevision = !usuario?.tarjetasRevisadasAt && filas.length > 0;

    return { tarjetas, necesitaRevision };
  }

  /**
   * Apaga una tarjeta: desde ahora sus avisos no se importan.
   *
   * Con `quitarImportados`, además borra las transacciones que ya entraron por
   * correo con esa terminación. Solo esas: se encuentran por el enlace
   * correo → transacción, así que lo registrado a mano o por Zenio nunca se
   * toca. Los correos quedan marcados como omitidos para que una sincronización
   * futura no los vuelva a importar.
   */
  static async exclude(userId: string, last4: string, quitarImportados: boolean): Promise<{ quitados: number }> {
    await prisma.cardExclusion.upsert({
      where: { userId_last4: { userId, last4 } },
      update: {},
      create: { userId, last4 },
    });

    if (!quitarImportados) return { quitados: 0 };

    const correos = await prisma.$queryRawUnsafe<{ id: string; transactionId: string }[]>(`
      SELECT e.id, e."transactionId"
      FROM imported_bank_emails e
      JOIN email_connections c ON c.id = e."emailConnectionId"
      WHERE c."userId" = $1
        AND e."parsedData"->>'cardLast4' = $2
        AND e."transactionId" IS NOT NULL
    `, userId, last4);

    if (correos.length === 0) return { quitados: 0 };

    const idsTransaccion = correos.map(c => c.transactionId);

    // Se leen ANTES de borrar: hacen falta categoría y fecha para recalcular
    // los presupuestos que tocaban.
    // Solo GASTOS: un reembolso a esa tarjeta (ingreso) no es un consumo, y
    // tiene que coincidir con lo que listCards le mostró al usuario.
    const transacciones = await prisma.transaction.findMany({
      where: { id: { in: idsTransaccion }, userId, type: 'EXPENSE' },
      select: { id: true, category_id: true, date: true },
    });

    if (transacciones.length === 0) return { quitados: 0 };
    const idsBorrar = new Set(transacciones.map(t => t.id));

    // Todo o nada: si falla a mitad, no quedan transacciones borradas con su
    // correo todavía apuntando a ellas (ni al revés).
    await prisma.$transaction([
      prisma.transaction.deleteMany({
        where: { id: { in: transacciones.map(t => t.id) }, userId, type: 'EXPENSE' },
      }),
      // Solo los correos cuya transacción se borró: si alguno apuntaba a un
      // ingreso, sigue enlazado a él.
      prisma.importedBankEmail.updateMany({
        where: { id: { in: correos.filter(c => idsBorrar.has(c.transactionId)).map(c => c.id) } },
        data: {
          status: 'SKIPPED',
          transactionId: null,
          errorMessage: `${CARD_EXCLUDED_SKIPPED}: consumo de la tarjeta terminada en ${last4}, quitado por el usuario`,
        },
      }),
    ]);

    // Presupuestos afectados: uno por categoría y día distinto. Sin alertas:
    // quitar consumos no es un movimiento del usuario que merezca aviso.
    const vistos = new Set<string>();
    for (const t of transacciones) {
      const clave = `${t.category_id}|${t.date.toISOString().slice(0, 10)}`;
      if (vistos.has(clave)) continue;
      vistos.add(clave);
      try {
        await recalculateBudgets(userId, t.category_id, t.date, { notify: false });
      } catch (error) {
        logger.error(`[CardExclusion] Error recalculando presupuesto (${clave}):`, error);
      }
    }

    // recalculateBudgets solo toca presupuestos ACTIVOS. Pero lo quitado puede
    // ser de hasta 90 días atrás (la primera lectura del correo), y el
    // presupuesto de un mes ya cerrado se quedaría con el gastado viejo. Se
    // recalculan también esos, con el mismo criterio (suma del tipo del
    // presupuesto dentro de su período). Pasó en la limpieza del 2026-10-04.
    try {
      await prisma.$executeRawUnsafe(`
        UPDATE budgets b SET spent = COALESCE((
          SELECT SUM(t.amount) FROM transactions t
          WHERE t."userId" = b.user_id AND t.category_id = b.category_id
            AND t.type::text = b.type::text
            AND t.date >= b.start_date AND t.date <= b.end_date), 0)
        WHERE b.user_id = $1 AND b.is_active = false
          AND b.category_id = ANY($2)
          AND b.start_date <= $4 AND b.end_date >= $3
      `,
        userId,
        [...new Set(transacciones.map(t => t.category_id))],
        new Date(Math.min(...transacciones.map(t => t.date.getTime()))),
        new Date(Math.max(...transacciones.map(t => t.date.getTime()))),
      );
    } catch (error) {
      logger.error('[CardExclusion] Error recalculando presupuestos cerrados:', error);
    }

    logger.log(`[CardExclusion] Usuario ${userId}: tarjeta ${last4} excluida, ${transacciones.length} consumos quitados`);
    return { quitados: transacciones.length };
  }

  /** Vuelve a encender una tarjeta: se importa de nuevo de ahí en adelante. */
  static async include(userId: string, last4: string): Promise<void> {
    await prisma.cardExclusion.deleteMany({ where: { userId, last4 } });
  }

  /** El usuario ya vio la lista de tarjetas: no se le vuelve a presentar. */
  static async markReviewed(userId: string): Promise<void> {
    await prisma.user.update({
      where: { id: userId },
      data: { tarjetasRevisadasAt: new Date() },
    });
  }
}
