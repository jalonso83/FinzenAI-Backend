import { NotificationType, SubscriptionPlan } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { logger } from '../utils/logger';
import { NotificationService } from './notificationService';

/**
 * ─── Los dos avisos de una concesión de plan ─────────────────────────────────
 *
 * Un período de gracia tiene dos momentos en los que el usuario TIENE que
 * enterarse, y hasta ahora no existía ninguno:
 *
 *   1. Al empezar. Un regalo que la persona no sabe que recibió no cambia su
 *      comportamiento; es exactamente igual que no habérselo dado.
 *   2. Al acabarse. Sin aviso, un día abre la app y las cosas dejaron de
 *      funcionar sin explicación. Es el mismo error que ya cometimos con el
 *      downgrade de Apple, repetido: no hay nada peor que quitar en silencio.
 *
 * Los dos van como SUBSCRIPTION_GRANTED (transaccional, sin opt-out) y con
 * `ignoreQuietHours`: son avisos únicos, y el horario silencioso descarta en vez
 * de aplazar, así que uno otorgado de madrugada se perdería para siempre.
 */

const NOMBRE_PLAN: Record<string, string> = {
  PREMIUM: 'Plus',
  PRO: 'Pro',
};

function formatearFecha(d: Date): string {
  return d.toLocaleDateString('es-ES', { day: 'numeric', month: 'long' });
}

/**
 * Aviso de que se le acaba de regalar un plan.
 *
 * `mensajePersonalizado` permite escribir el cuerpo desde el panel. Se usa
 * cuando el motivo importa ("perdón por el fallo de ayer") y el texto genérico
 * quedaría frío.
 */
export async function notifyGrantStarted(
  userId: string,
  plan: SubscriptionPlan,
  hasta: Date,
  mensajePersonalizado?: string,
): Promise<void> {
  try {
    const nombre = NOMBRE_PLAN[plan] || plan;

    // Mencionar la sincronización de correo SOLO si es Pro y si de verdad la
    // usaba: al bajar de Pro las conexiones se BORRAN, no se pausan, así que
    // devolverle el plan no le devuelve el correo conectado — el OAuth lo tiene
    // que rehacer. Decírselo a quien nunca lo usó solo añade ruido.
    //
    // El rastro no puede buscarse en EmailConnection ni en sus logs: cuelgan de
    // la conexión con onDelete: Cascade, así que al degradar desaparecen todos.
    // Lo que SÍ sobrevive es el historial de notificaciones, que es por usuario.
    let usabaCorreo = false;
    if (plan === SubscriptionPlan.PRO) {
      const avisosDeSync = await prisma.notificationLog.count({
        where: { userId, type: NotificationType.EMAIL_SYNC_COMPLETE },
      });
      usabaCorreo = avisosDeSync > 0;
    }

    const cuerpo =
      mensajePersonalizado?.trim() ||
      `Tienes FinZen ${nombre} activo hasta el ${formatearFecha(hasta)}, sin costo y sin tarjeta.` +
        (usabaCorreo
          ? ' Tu sincronización con el correo quedó desconectada: vuelve a activarla desde Ajustes.'
          : '');

    await NotificationService.sendToUser(userId, NotificationType.SUBSCRIPTION_GRANTED, {
      title: `Te activamos FinZen ${nombre}`,
      body: cuerpo,
      data: { screen: 'Subscriptions' },
      ignoreQuietHours: true,
    });

    logger.log(`[Grants] Aviso de concesión enviado a ${userId} (${plan} hasta ${hasta.toISOString()})`);
  } catch (error) {
    // Best-effort: la concesión ya está aplicada, avisar no debe tumbarla.
    logger.error(`[Grants] No se pudo avisar la concesión a ${userId}:`, error);
  }
}

/** Aviso de que la concesión se acaba en unos días. */
export async function notifyGrantEnding(
  userId: string,
  plan: SubscriptionPlan,
  hasta: Date,
  diasRestantes: number,
): Promise<void> {
  const nombre = NOMBRE_PLAN[plan] || plan;
  await NotificationService.sendToUser(userId, NotificationType.SUBSCRIPTION_GRANTED, {
    title: `Te quedan ${diasRestantes} día${diasRestantes === 1 ? '' : 's'} de ${nombre}`,
    body:
      `Tu acceso a FinZen ${nombre} termina el ${formatearFecha(hasta)}. ` +
      'Si quieres conservarlo, puedes suscribirte desde la app.',
    data: { screen: 'Subscriptions' },
    ignoreQuietHours: true,
  });
}
