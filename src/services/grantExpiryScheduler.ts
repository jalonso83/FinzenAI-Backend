import cron from 'node-cron';
import { prisma } from '../lib/prisma';
import { logger } from '../utils/logger';
import { notifyGrantEnding } from './grantNotices';

/**
 * Avisa a quien tiene un plan REGALADO de que se le acaba.
 *
 * Sin esto, la concesión se apaga sola —lo cual está bien, es lo que evita
 * estados colgados— pero la persona lo descubre chocándose: abre la app y el
 * correo ya no sincroniza, o no puede crear otro presupuesto. Es exactamente el
 * mismo error que cometimos con el downgrade de Apple.
 *
 * El aviso además es el mejor momento comercial que hay: alguien que lleva
 * semanas usando Pro y a quien le quedan 3 días es el candidato más caliente a
 * suscribirse. Quitarlo en silencio desperdicia eso.
 */
export class GrantExpiryScheduler {
  private static readonly DIAS_DE_AVISO = 3;

  static startScheduler(): void {
    // Una vez al día a las 14:00 UTC = 10:00 en República Dominicana. A media
    // mañana, no de madrugada: aunque el aviso ignora el horario silencioso,
    // que llegue a una hora razonable es mejor que confiar en esa excepción.
    cron.schedule('0 14 * * *', () => {
      void this.run();
    });
    logger.log('[GrantExpiry] Programado: diario 14:00 UTC');
  }

  /** Expuesto para poder dispararlo a mano al depurar. */
  static async run(): Promise<void> {
    try {
      const ahora = new Date();
      const limite = new Date(ahora.getTime() + this.DIAS_DE_AVISO * 86400000);

      const porCaducar = await prisma.subscription.findMany({
        where: {
          grantedPlan: { not: null },
          grantExpiryNoticeSent: false,
          // Vigentes todavía (> ahora) pero dentro de la ventana de aviso.
          grantedUntil: { gt: ahora, lte: limite },
        },
        select: { userId: true, grantedPlan: true, grantedUntil: true },
      });

      if (porCaducar.length === 0) return;
      logger.log(`[GrantExpiry] ${porCaducar.length} concesión(es) por caducar`);

      for (const s of porCaducar) {
        try {
          const dias = Math.max(
            1,
            Math.ceil((s.grantedUntil!.getTime() - ahora.getTime()) / 86400000),
          );
          await notifyGrantEnding(s.userId, s.grantedPlan!, s.grantedUntil!, dias);

          // Se marca DESPUÉS de avisar y por usuario: si uno falla, los demás
          // siguen avisándose y ese vuelve a intentarse mañana.
          await prisma.subscription.update({
            where: { userId: s.userId },
            data: { grantExpiryNoticeSent: true },
          });
        } catch (error) {
          logger.error(`[GrantExpiry] Falló el aviso a ${s.userId}:`, error);
        }
      }
    } catch (error) {
      logger.error('[GrantExpiry] Error en la pasada diaria:', error);
    }
  }
}
