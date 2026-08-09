import * as cron from 'node-cron';
import { prisma } from '../../lib/prisma';
import { logger } from '../../utils/logger';
import { NotificationType } from '@prisma/client';
import { isTargetLocalTime } from '../../utils/timezone';
import { NotificationService } from '../notificationService';
import { isH13Enabled, isH13FlagOn } from '../../config/h13';
import { H13_KEY_PREFIX, h13Params, H13_CHALLENGE_NAME, type H13Data, localDateKey, closeExpiredChallenges } from './h13Service';
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
  // Aquí había un `WINDOW_DAYS = 7` propio, copiado porque cuando nació este
  // archivo (28 jul) la constante de h13Service todavía no se exportaba (se
  // exportó el 29). Quedó desincronizado: cambiar la ventana en el servicio no
  // cambiaba la de los cues. Ahora la ventana sale de h13Params(data), que da la
  // CONGELADA de cada participante — no una global.

  // Nombre fijo del reto: no menciona la duración porque las ediciones son de 7,
  // 15, 30 o 45 días. La duración va en el cuerpo del mensaje cuando aplica.
  private static readonly CUE_TITLE = `${H13_CHALLENGE_NAME} 🔥`;
  // Variantes rotadas por día del reto (sección 3.3 del paquete). {n} = día del reto.
  private static readonly CUE_VARIANTS = [
    '¿Qué se movió hoy en tu dinero? Anótalo en 10 segundos.',
    'Día {n} del reto: un gasto, 10 segundos, y seguimos 🔥',
    'Tu reto va en el día {n}. ¿Anotamos lo de hoy?',
  ];

  // Cuándo el cue deja de ser genérico y pasa a decir cuánto falta y cuánto queda.
  // No es un push extra: es el mismo recordatorio diario con contexto, que es lo
  // que crea urgencia real.
  //
  // Antes era un día fijo (`URGENCY_FROM_DAY = 4`), calibrado para la ventana de
  // 7: urgencia en los últimos 4 días. Con la ventana parametrizable eso se rompe
  // — en un reto de 15 días la urgencia arrancaría el día 4, con 12 días por
  // delante, y le repetiría "te faltan 3 y te quedan 12" doce días seguidos.
  //
  // Ahora la condición es RELATIVA al margen: el aviso entra cuando los días que
  // le quedan se acercan a los que todavía necesita. Se ajusta solo a cualquier
  // ventana.
  //
  // OJO, con ventana de 7 NO es idéntica a la anterior: es igual o MÁS ESTRICTA,
  // nunca dispara antes. Quien no ha registrado nada entra en urgencia el día 4,
  // igual que antes; pero quien ya lleva 1 ó 2 días entra más tarde (día 5 y 6
  // respectivamente, en vez del 4). Es a propósito: decirle "te falta 1 día y te
  // quedan 4" no es urgencia, es ruido. El aviso aparece cuando de verdad aprieta.
  //
  // El efecto grande está en las ventanas largas. Con la regla vieja, un reto de
  // 45 días le habría mandado el mensaje de urgencia 24 días seguidos; con esta,
  // 2 días.
  private static readonly URGENCY_MARGIN_DAYS = 1;

  /**
   * Cue con progreso para quien va corto.
   *   `faltan` = días de REGISTRO que todavía necesita para llegar a la meta
   *   `quedan` = días de CALENDARIO que le quedan de reto (hoy incluido)
   *
   * El texto anterior era "Te faltan 3 días y te quedan 3 días", que se lee como
   * una redundancia absurda. Los dos números miden cosas distintas, pero
   * compartían la palabra "días" y la misma estructura, así que la diferencia
   * desaparecía. Ahora se separan los sustantivos: REGISTROS para lo que le
   * falta hacer, DÍAS para el calendario.
   *
   * Además, con la urgencia relativa (quedan <= faltan + URGENCY_MARGIN_DAYS) más
   * la guarda faltan <= quedan, aquí solo pueden darse DOS situaciones: sin
   * margen (quedan === faltan) o con un día de colchón. Por eso cada una lleva su
   * texto propio en vez de una plantilla genérica con dos variables — antes hacían
   * falta porque la regla vieja admitía muchas más combinaciones.
   */
  private static urgencyBody(faltan: number, quedan: number, morning: boolean): string {
    // A las 8am el día todavía no pasó: se le pregunta por AYER.
    const anota = morning ? 'Anota lo de ayer' : 'Anota lo de hoy';
    const dias = (n: number) => (n === 1 ? '1 día' : `${n} días`);

    // Le falta uno solo: es el más motivador y no hace falta hablar de plazos.
    if (faltan === 1) {
      return `Un registro más y completas el reto. ${anota}.`;
    }

    // Sin margen: tiene que registrar todos los días que le quedan.
    if (quedan <= faltan) {
      return `Te quedan ${dias(quedan)} y necesitas los ${faltan}. ${anota} y sigues en carrera.`;
    }

    // Con un día de colchón: puede fallar uno y todavía llegar.
    return `Necesitas ${faltan} registros y te quedan ${dias(quedan)}. ${anota} y sigues en carrera.`;
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
      // Por prefijo: los cues siguen corriendo para quien esté a mitad de una
      // corrida anterior, aunque ya haya arrancado la siguiente.
      where: { experimentKey: { startsWith: H13_KEY_PREFIX }, arm: 'reto', state: 'ACTIVE' },
      select: {
        userId: true,
        assignedAt: true,
        data: true,
        experimentKey: true, // la corrida de ESTE participante (para el evento)
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

        // Ventana y objetivo CONGELADOS de este participante (no globales).
        const { windowDays, targetDays } = h13Params(data);

        const dayN = Math.floor((now.getTime() - new Date(p.assignedAt).getTime()) / 86_400_000) + 1;
        if (dayN < 1 || dayN > windowDays) continue;

        // ¿Es la hora local elegida por el usuario? (tolerancia ±30min del helper)
        if (!isTargetLocalTime(p.user.country, reminderHour, 0)) continue;

        const todayKey = localDateKey(p.user.country, now);

        // ¿Ya registró una TX válida HOY (día local)? Traemos las TX recientes y
        // comparamos su día local (las TX se guardan a mediodía UTC).
        const recentTx = await prisma.transaction.findMany({
          where: {
            userId: p.userId,
            amount: { gt: 0 },
            // Sin `category_id: { not: null }`: el campo es obligatorio en el
            // schema y Prisma lanza con ese filtro. Ver nota en h13Service.
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
            experimentKey: p.experimentKey,
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
        const faltan = targetDays - llevaDias;
        const quedan = windowDays - dayN + 1; // hoy incluido

        let body: string;
        // Urgencia cuando el margen se estrecha: los días que le quedan ya casi
        // no dan holgura sobre los que necesita. Relativo, no un día fijo.
        const margenApretado = quedan <= faltan + this.URGENCY_MARGIN_DAYS;
        if (margenApretado && faltan > 0 && faltan <= quedan) {
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
        await trackExperimentEvent(p.experimentKey, p.userId, 'h13_cue_sent', { dayN, channel: 'push' });
        sent++;
      } catch (err) {
        logger.error(`[H13CueScheduler] Error con usuario ${p.userId}:`, err);
      }
    }

    if (sent > 0) logger.log(`[H13CueScheduler] ✅ ${sent} cue(s) enviados`);
  }
}
