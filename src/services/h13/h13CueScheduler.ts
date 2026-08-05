import * as cron from 'node-cron';
import { prisma } from '../../lib/prisma';
import { logger } from '../../utils/logger';
import { NotificationType } from '@prisma/client';
import { isTargetLocalTime } from '../../utils/timezone';
import { NotificationService } from '../notificationService';
import { isH13Enabled, isH13FlagOn, isH13Whitelisted } from '../../config/h13';
import { H13_KEY, H13_TARGET_DAYS, type H13Data, localDateKey, closeExpiredChallenges } from './h13Service';
import { trackExperimentEvent } from '../experiments/experimentEvents';

/**
 * H13 · Cue diario del reto. Clon del patrón de tipScheduler (timezone-aware):
 * corre cada hora y, para cada participante en estado ACTIVE dentro de la ventana
 * de 7 días, envía UN recordatorio a la hora local que el usuario eligió — solo si
 * ese día todavía NO registró una transacción y no se le mandó ya un cue hoy.
 *
 * Todo detrás del flag H13_ENABLED. Máx 1 push/día por el guard de h13_cue_sent.
 */
export class H13CueScheduler {
  private static isRunning = false;
  private static cronTask: cron.ScheduledTask | null = null;
  private static readonly WINDOW_DAYS = 7;

  private static readonly CUE_TITLE = 'Reto de la Primera Semana 🔥';
  // Variantes rotadas por día del reto (sección 3.3 del paquete). {n} = día del reto.
  private static readonly CUE_VARIANTS = [
    '¿Qué se movió hoy en tu dinero? Anótalo en 10 segundos.',
    'Día {n} del reto: un gasto, 10 segundos, y seguimos 🔥',
    'Tu reto va en el día {n}. ¿Anotamos lo de hoy?',
  ];

  // Desde este día del reto, si el usuario todavía NO llegó a la meta, el cue deja
  // de ser genérico y le dice cuánto le falta y cuánto le queda. No es un push
  // extra: es el mismo recordatorio diario con contexto, que es lo que crea
  // urgencia real. Antes del día 4 no hay nada urgente que comunicar.
  private static readonly URGENCY_FROM_DAY = 4;

  /**
   * Cue con progreso para quien va corto. `faltan` = días que le faltan para la
   * meta; `quedan` = días de ventana que le quedan (hoy incluido).
   */
  private static urgencyBody(faltan: number, quedan: number, morning: boolean): string {
    const dias = (n: number) => (n === 1 ? '1 día' : `${n} días`);
    const accion = morning ? 'Anota lo de ayer' : 'Un registro hoy';
    if (faltan === 1) {
      return `Te falta ${dias(1)} y te quedan ${dias(quedan)}. ${accion} y completas el reto.`;
    }
    return `Te faltan ${dias(faltan)} y te quedan ${dias(quedan)}. ${accion} y sigues en carrera.`;
  }

  // A esta hora el día todavía no pasó: pedir "lo de hoy" no tiene sentido.
  // El cue matutino pregunta por AYER, que es como la gente usa esa franja.
  private static readonly MORNING_HOUR = 8;
  private static readonly MORNING_CUE_VARIANTS = [
    '¿Qué gastaste ayer? Anótalo en 10 segundos y sigue el reto.',
    'Día {n} del reto: anota lo de ayer y arrancamos el día 🔥',
    'Tu reto va en el día {n}. ¿Repasamos lo de ayer?',
  ];

  static startScheduler(): void {
    if (this.isRunning) return;
    this.cronTask = cron.schedule('0 * * * *', async () => {
      try {
        await this.sendCuesToActiveChallenges();
      } catch (error) {
        logger.error('[H13CueScheduler] Error enviando cues:', error);
      }
      try {
        await closeExpiredChallenges(); // Fase 7 · cierre de retos vencidos (día 7)
      } catch (error) {
        logger.error('[H13CueScheduler] Error cerrando retos vencidos:', error);
      }
    });
    this.isRunning = true;
    logger.log('[H13CueScheduler] 🚀 Iniciado (cada hora, timezone-aware, hora elegida por el usuario)');
  }

  static stopScheduler(): void {
    if (this.cronTask) { this.cronTask.stop(); this.cronTask = null; }
    this.isRunning = false;
  }

  /** ¿Hay alguien en la whitelist? Evita recorrer participantes cuando no hay
   *  ni flag global ni dogfood configurado. */
  private static hayWhitelist(): boolean {
    return (process.env.H13_WHITELIST || '').split(',').some((s) => s.trim().length > 0);
  }

  static async sendCuesToActiveChallenges(): Promise<void> {
    // OJO: NO usar `isH13Enabled()` sin userId aquí. Sin argumento ignora la
    // whitelist y solo mira el flag global, así que con H13_ENABLED=false el
    // scheduler se cortaba en esta línea y los usuarios de dogfood nunca recibían
    // su recordatorio diario — aunque el resto del reto les funcionara.
    // El corte por usuario se hace abajo, que es donde sí hay userId.
    if (!isH13FlagOn() && !this.hayWhitelist()) return;

    // Participantes del reto en curso (ACTIVE). El filtro fino (ventana, hora, opt-out,
    // ¿registró hoy?) se hace por usuario abajo.
    const active = await prisma.experimentParticipant.findMany({
      where: { experimentKey: H13_KEY, arm: 'reto', state: 'ACTIVE' },
      select: {
        userId: true,
        assignedAt: true,
        data: true,
        user: { select: { country: true } },
      },
    });

    if (active.length === 0) return;
    const now = new Date();
    let sent = 0;

    for (const p of active) {
      try {
        // Corte por usuario: con el flag global apagado solo pasan los de la
        // whitelist (dogfood). Aquí sí hay userId, así que la whitelist cuenta.
        if (!isH13Enabled(p.userId)) continue;

        const data = (p.data as H13Data) ?? {};
        if (data.optedOutAt) continue;                 // silenció los cues (sigue en el brazo)
        const reminderHour = data.reminderHour;
        if (reminderHour == null) continue;

        // Ventana del reto: 7 días desde la asignación.
        const dayN = Math.floor((now.getTime() - new Date(p.assignedAt).getTime()) / 86_400_000) + 1;
        if (dayN < 1 || dayN > this.WINDOW_DAYS) continue;

        // ¿Es la hora local elegida por el usuario? (tolerancia ±30min del helper)
        if (!isTargetLocalTime(p.user.country, reminderHour, 0)) continue;

        const todayKey = localDateKey(p.user.country, now);

        // ¿Ya registró una TX válida HOY (día local)? Traemos las TX recientes y
        // comparamos su día local (las TX se guardan a mediodía UTC).
        const recentTx = await prisma.transaction.findMany({
          where: {
            userId: p.userId,
            amount: { gt: 0 },
            category_id: { not: null },
            date: { gte: new Date(now.getTime() - 48 * 3600_000) },
          },
          select: { date: true },
        });
        const registeredToday = recentTx.some((t) => localDateKey(p.user.country, t.date) === todayKey);
        if (registeredToday) continue;

        // ¿Ya se le mandó un cue hoy? (garantiza máx 1/día)
        const cueToday = await prisma.experimentEvent.findFirst({
          where: {
            userId: p.userId,
            experimentKey: H13_KEY,
            eventType: 'h13_cue_sent',
            createdAt: { gte: new Date(now.getTime() - 20 * 3600_000) },
          },
          select: { id: true },
        });
        if (cueToday) continue;

        const esMañana = reminderHour === this.MORNING_HOUR;

        // Días distintos que ya lleva. Viene de `data.daysWithTx`, que
        // processRetoProgress actualiza en cada transacción válida.
        const llevaDias = data.daysWithTx ?? 0;
        const faltan = H13_TARGET_DAYS - llevaDias;
        const quedan = this.WINDOW_DAYS - dayN + 1; // hoy incluido

        let body: string;
        if (dayN >= this.URGENCY_FROM_DAY && faltan > 0 && faltan <= quedan) {
          // Va corto pero todavía le da: se le dice exactamente cuánto le falta.
          body = this.urgencyBody(faltan, quedan, esMañana);
        } else {
          // Día temprano, ya cumplió la meta, o ya no le da el tiempo: cue normal.
          // (Si no le da, insistir con "te faltan 2 y te queda 1" solo frustra.)
          const variants = esMañana ? this.MORNING_CUE_VARIANTS : this.CUE_VARIANTS;
          body = variants[(dayN - 1) % variants.length].replace('{n}', String(dayN));
        }

        await NotificationService.sendToUser(p.userId, NotificationType.SYSTEM, {
          title: this.CUE_TITLE,
          body,
          data: { screen: 'Transactions', h13: 'cue' },
        });
        await trackExperimentEvent(H13_KEY, p.userId, 'h13_cue_sent', { dayN, channel: 'push' });
        sent++;
      } catch (err) {
        logger.error(`[H13CueScheduler] Error con usuario ${p.userId}:`, err);
      }
    }

    if (sent > 0) logger.log(`[H13CueScheduler] ✅ ${sent} cue(s) enviados`);
  }
}
