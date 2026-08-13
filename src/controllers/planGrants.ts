import { Request, Response } from 'express';
import { SubscriptionPlan } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { subscriptionService } from '../services/subscriptionService';
import { PLANS } from '../config/stripe';
import { notifyGrantStarted } from '../services/grantNotices';
import { logger } from '../utils/logger';

/**
 * ─── Concesiones manuales de plan ────────────────────────────────────────────
 *
 * Regalar Plus o Pro por un tiempo: recuperar a alguien que se fue, disculparse
 * por un bug que le costó algo, dejar entrar a un beta tester. Hasta ahora no
 * había forma de hacerlo salvo tocar `subscriptions.plan` a mano en la base, y
 * eso tiene dos problemas que no se ven hasta que muerden:
 *
 *   1. No caduca. Alguien tiene que acordarse dentro de tres meses.
 *   2. Se borra solo. `plan` es el campo que Stripe y RevenueCat sobrescriben
 *      en cada sincronización. Basta con que la persona toque "Restaurar
 *      compras" para que `verifyAndSyncPurchase` pregunte a RevenueCat, no
 *      encuentre nada activo y llame a `downgradeToFree`: el regalo desaparece
 *      sin que nadie se entere, justo delante de quien acababa de recibirlo.
 *
 * Por eso la concesión vive en sus propios campos (`grantedPlan`,
 * `grantedUntil`, `grantedReason`) y la resuelve `getUserSubscription` al leer.
 * Ningún webhook la toca y caduca sola sin depender de un cron.
 *
 * OJO con Pro y el correo: bajar de Pro BORRA las conexiones de email
 * (`revenueCatService.downgradeToFree`), no las pausa. Devolverle Pro a alguien
 * le devuelve el permiso, pero la reconexión OAuth la tiene que hacer la
 * persona. Si le prometes que "se le reactiva el correo", eso hay que decírselo.
 */

const DIAS_MAX = 365;

/** POST /api/admin/users/:userId/grant  body: { plan, days, reason } */
export const grantPlan = async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;
    // `notify` por defecto TRUE: el caso normal es que la persona se entere. Se
    // apaga cuando el aviso lo das tú por otro canal (un correo escrito a mano),
    // donde un push automático diciendo lo mismo abarata el gesto.
    const { plan, days, reason, notify = true, message } = req.body ?? {};

    if (!plan || !(plan in PLANS) || plan === 'FREE') {
      return res.status(400).json({
        message: 'Plan inválido. Usa PREMIUM o PRO (regalar FREE no tiene sentido).',
      });
    }

    const dias = Number(days);
    if (!Number.isInteger(dias) || dias < 1 || dias > DIAS_MAX) {
      return res.status(400).json({
        message: `Los días deben ser un entero entre 1 y ${DIAS_MAX}.`,
      });
    }

    if (!reason || typeof reason !== 'string' || reason.trim().length < 3) {
      // El motivo no es burocracia: dentro de seis meses, mirando la fila, es lo
      // único que explica por qué esta persona tiene Pro sin haber pagado.
      return res.status(400).json({ message: 'Indica un motivo para la concesión.' });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true },
    });
    if (!user) {
      return res.status(404).json({ message: 'Usuario no encontrado' });
    }

    // Se cuenta desde HOY, no desde el vencimiento anterior: dos concesiones
    // seguidas no se acumulan, la segunda reemplaza a la primera. Acumular sería
    // la forma fácil de regalar un año sin querer.
    const grantedUntil = new Date();
    grantedUntil.setDate(grantedUntil.getDate() + dias);

    // `upsert` y no `update`: hoy todos los usuarios tienen fila de suscripción
    // (se crea en el registro), pero si alguna vez falta, un `update` devolvería
    // un 500 sin explicar nada. Regalar un plan no debería depender de que la
    // fila exista — se crea en FREE, que es el plan real de quien nunca pagó, y
    // la concesión va encima.
    await prisma.subscription.upsert({
      where: { userId },
      create: {
        userId,
        plan: SubscriptionPlan.FREE,
        grantedPlan: plan as SubscriptionPlan,
        grantedUntil,
        grantedReason: reason.trim(),
      },
      update: {
        grantedPlan: plan as SubscriptionPlan,
        grantedUntil,
        grantedReason: reason.trim(),
        // Una concesión nueva reabre el aviso de caducidad: si no, quien ya
        // recibió el "te quedan 3 días" de una anterior no volvería a recibirlo
        // nunca, y esta se le apagaría en silencio.
        grantExpiryNoticeSent: false,
      },
    });

    if (notify) {
      // Sin `await`: el aviso es best-effort y no debe hacer esperar —ni fallar—
      // a la respuesta. La concesión ya está aplicada.
      void notifyGrantStarted(userId, plan as SubscriptionPlan, grantedUntil, message);
    }

    const actualizada = await subscriptionService.getUserSubscription(userId);

    logger.log(
      `[Grants] ${plan} por ${dias} días a ${user.email} hasta ${grantedUntil.toISOString()} — ${reason.trim()}`,
    );

    return res.json({
      message: `Concesión aplicada: ${plan} por ${dias} días.`,
      userId,
      email: user.email,
      grantedPlan: plan,
      grantedUntil,
      grantedReason: reason.trim(),
      planReal: actualizada.planReal,
      planEfectivo: actualizada.plan,
    });
  } catch (error: any) {
    logger.error('[Grants] Error otorgando plan:', error);
    return res.status(500).json({ message: 'Error al otorgar el plan', error: error.message });
  }
};

/** DELETE /api/admin/users/:userId/grant — retirar la concesión antes de tiempo */
export const revokeGrant = async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;

    const sub = await prisma.subscription.findUnique({
      where: { userId },
      select: { grantedPlan: true },
    });
    if (!sub) {
      return res.status(404).json({ message: 'Suscripción no encontrada' });
    }
    if (!sub.grantedPlan) {
      return res.status(400).json({ message: 'Este usuario no tiene ninguna concesión' });
    }

    await prisma.subscription.update({
      where: { userId },
      data: { grantedPlan: null, grantedUntil: null, grantedReason: null, grantExpiryNoticeSent: false },
    });

    const actualizada = await subscriptionService.getUserSubscription(userId);
    logger.log(`[Grants] Concesión retirada a ${userId}`);

    return res.json({
      message: 'Concesión retirada',
      userId,
      planEfectivo: actualizada.plan,
    });
  } catch (error: any) {
    logger.error('[Grants] Error retirando concesión:', error);
    return res.status(500).json({ message: 'Error al retirar la concesión', error: error.message });
  }
};

/** GET /api/admin/grants — quién tiene un plan regalado ahora mismo */
export const listGrants = async (_req: Request, res: Response) => {
  try {
    const ahora = new Date();
    const concesiones = await prisma.subscription.findMany({
      where: { grantedPlan: { not: null } },
      select: {
        userId: true,
        plan: true,
        grantedPlan: true,
        grantedUntil: true,
        grantedReason: true,
        user: { select: { email: true, name: true, lastName: true } },
      },
      orderBy: { grantedUntil: 'desc' },
    });

    // Las caducadas se siguen devolviendo, marcadas: son el historial de a quién
    // se le regaló qué y por qué. Borrarlas al vencer perdería justo eso.
    return res.json({
      grants: concesiones.map((c) => ({
        ...c,
        vigente: c.grantedUntil != null && c.grantedUntil > ahora,
      })),
    });
  } catch (error: any) {
    logger.error('[Grants] Error listando concesiones:', error);
    return res.status(500).json({ message: 'Error al listar concesiones', error: error.message });
  }
};
