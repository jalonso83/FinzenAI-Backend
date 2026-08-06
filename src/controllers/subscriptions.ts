import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { stripeService } from '../services/stripeService';
import { subscriptionService } from '../services/subscriptionService';
import { EmailSyncService } from '../services/emailSyncService';
import { PLANS, PlanType, BillingPeriod, getPriceId, getPlanFromPriceId, getSubscriptionPeriod, stripe } from '../config/stripe';
import { sanitizeLimit, PAGINATION } from '../config/pagination';
import jwt from 'jsonwebtoken';
import { ENV } from '../config/env';
import { recordFeatureUsage } from '../lib/featureUsage';

import { logger } from '../utils/logger';
/**
 * Crear sesión de checkout para upgrade de plan
 */
export const createCheckout = async (req: Request, res: Response) => {
  try {
    const { plan, billingPeriod = 'monthly' } = req.body as {
      plan: PlanType;
      billingPeriod?: BillingPeriod;
    };
    const userId = (req as any).user!.id;

    // Validar plan
    if (!plan || !['PREMIUM', 'PRO'].includes(plan)) {
      return res.status(400).json({ message: 'Plan inválido' });
    }

    // Validar período de facturación
    if (!['monthly', 'yearly'].includes(billingPeriod)) {
      return res.status(400).json({ message: 'Período de facturación inválido' });
    }

    // Obtener el price ID correcto según plan y período
    const priceId = getPriceId(plan, billingPeriod);
    if (!priceId) {
      return res.status(400).json({ message: 'Plan no disponible para este período' });
    }

    // Verificar que no tenga ya una suscripción activa del mismo plan
    const currentSubscription = await subscriptionService.getUserSubscription(userId);
    if (currentSubscription.plan === plan && currentSubscription.status === 'ACTIVE') {
      return res.status(400).json({ message: 'Ya tienes este plan activo' });
    }

    // URL base del backend (Railway) para Universal Links
    const backendUrl = process.env.BACKEND_URL || 'https://finzenai-backend-production.up.railway.app';

    // Crear sesión de checkout con URLs que soportan Universal Links
    const session = await stripeService.createCheckoutSession(
      userId,
      priceId,
      `${backendUrl}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
      `${backendUrl}/checkout/cancel`
    );

    res.json({ url: session.url, sessionId: session.id });
  } catch (error: any) {
    logger.error('Error creando checkout:', error);
    res.status(500).json({
      message: 'Error al crear sesión de pago',
      error: error.message
    });
  }
};

/**
 * Iniciar período de prueba de 7 días (sin tarjeta)
 * El usuario selecciona un plan y obtiene trial gratis
 */
export const startTrial = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user!.id;
    const { plan, deviceId, platform, deviceName } = req.body as {
      plan: 'PREMIUM' | 'PRO';
      deviceId?: string;
      platform?: 'ios' | 'android';
      deviceName?: string;
    };

    // Validar plan
    if (!plan || !['PREMIUM', 'PRO'].includes(plan)) {
      return res.status(400).json({ message: 'Plan inválido. Debe ser PREMIUM o PRO' });
    }

    // Verificar si el usuario ya usó el trial
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { hasUsedTrial: true, email: true, name: true }
    });

    if (!user) {
      return res.status(404).json({ message: 'Usuario no encontrado' });
    }

    if (user.hasUsedTrial) {
      return res.status(400).json({
        message: 'Ya has usado tu período de prueba gratuito',
        canUseTrial: false
      });
    }

    // Verificar si el dispositivo ya usó un trial (si se proporciona deviceId)
    if (deviceId) {
      const existingDeviceTrial = await prisma.trialDeviceRegistry.findUnique({
        where: { deviceId }
      });

      if (existingDeviceTrial) {
        logger.warn(`⚠️ Dispositivo ${deviceId} ya usó trial con usuario ${existingDeviceTrial.usedByUserId}`);

        // Marcar hasUsedTrial para que el cliente no intente trial de nuevo
        // y pueda ir directo al flujo de compra
        await prisma.user.update({
          where: { id: userId },
          data: { hasUsedTrial: true }
        });

        return res.status(400).json({
          message: 'Este dispositivo ya ha utilizado un período de prueba. Puedes suscribirte directamente.',
          canUseTrial: false
        });
      }
    }

    // Verificar que no tenga ya una suscripción activa pagada
    const currentSubscription = await subscriptionService.getUserSubscription(userId);
    if (currentSubscription.status === 'ACTIVE' && currentSubscription.plan !== 'FREE') {
      return res.status(400).json({ message: 'Ya tienes una suscripción activa' });
    }

    // Iniciar trial de 7 días
    const now = new Date();
    const trialEndsAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // +7 días

    await prisma.subscription.upsert({
      where: { userId },
      update: {
        status: 'TRIALING',
        plan: plan,
        trialStartedAt: now,
        trialEndsAt: trialEndsAt,
        trialNotificationsSent: []
      },
      create: {
        userId,
        status: 'TRIALING',
        plan: plan,
        trialStartedAt: now,
        trialEndsAt: trialEndsAt,
        trialNotificationsSent: []
      }
    });

    // Marcar que el usuario ya usó su trial
    await prisma.user.update({
      where: { id: userId },
      data: { hasUsedTrial: true }
    });

    // Registrar el dispositivo en trial_device_registry (si se proporciona deviceId)
    if (deviceId) {
      await prisma.trialDeviceRegistry.create({
        data: {
          deviceId,
          platform: platform || null,
          deviceName: deviceName || null,
          usedByUserId: userId,
          usedByEmail: user.email
        }
      });
      logger.log(`📱 Dispositivo registrado: ${deviceId} (${platform || 'unknown'})`);
    }

    // Cierra el embudo con 'ver_planes': cuántos de los que ven la pantalla
    // llegan a activar. Se registra aquí y no se deduce de subscription.
    // trialStartedAt porque el scheduler pone ese campo en NULL al vencer el
    // trial — o sea que los trials ya terminados serían invisibles.
    recordFeatureUsage(userId, 'suscripciones', 'inicio_trial');

    logger.log(`✅ Trial iniciado para usuario ${userId} - Plan: ${plan} - Termina: ${trialEndsAt.toISOString()}`);

    res.json({
      success: true,
      message: '¡Tu período de prueba de 7 días ha comenzado!',
      trial: {
        plan,
        startedAt: now,
        endsAt: trialEndsAt,
        daysRemaining: 7
      }
    });
  } catch (error: any) {
    logger.error('Error iniciando trial:', error);
    res.status(500).json({
      message: 'Error al iniciar período de prueba',
      error: error.message
    });
  }
};

/**
 * Obtener suscripción actual del usuario
 */
export const getSubscription = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user!.id;

    const subscription = await subscriptionService.getUserSubscription(userId);

    res.json(subscription);
  } catch (error: any) {
    logger.error('Error obteniendo suscripción:', error);
    res.status(500).json({
      message: 'Error al obtener suscripción',
      error: error.message
    });
  }
};

/**
 * Obtener todos los planes disponibles
 */
/**
 * userId del Bearer token si viene y es válido; null en cualquier otro caso.
 *
 * Se usa SOLO para telemetría en rutas públicas: nunca para autorizar. Por eso
 * no lanza ni responde 401 — si no hay token o no verifica, la ruta sigue siendo
 * pública exactamente igual que antes.
 */
function optionalUserId(req: Request): string | null {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return null;
    const decoded = jwt.verify(header.slice(7), ENV.JWT_SECRET, { algorithms: ['HS256'] }) as any;
    return typeof decoded?.userId === 'string' ? decoded.userId : null;
  } catch {
    return null;
  }
}

export const getPlans = async (req: Request, res: Response) => {
  try {
    // Telemetría de "vio la pantalla de planes". `fetchPlans()` se llama ÚNICAMENTE
    // desde SubscriptionsScreen (las dos apps), así que una llamada aquí equivale a
    // una visita a esa pantalla. No sirve /subscriptions/current para esto: lo pide
    // medio app (dashboard, presupuestos, metas) y mediría "abrió la app".
    //
    // Va aquí y no en la app a propósito: así empieza a medir con el deploy del
    // backend, sin esperar a que se propague un build.
    const viewerId = optionalUserId(req);
    if (viewerId) recordFeatureUsage(viewerId, 'suscripciones', 'ver_planes');

    // Retornar todos los planes: FREE, PREMIUM (Plus), PRO
    const plans = Object.entries(PLANS).map(([key, value]) => ({
      id: key,
      name: value.name,
      price: value.price, // { monthly: number, yearly: number }
      savings: (value as any).savings || null,
      limits: value.limits,
      features: value.features,
    }));

    res.json({ plans });
  } catch (error: any) {
    logger.error('Error obteniendo planes:', error);
    res.status(500).json({
      message: 'Error al obtener planes',
      error: error.message
    });
  }
};

/**
 * Cancelar suscripción (al final del período)
 * - Si está en TRIALING: vuelve a FREE inmediatamente (sin Stripe)
 * - Si tiene suscripción pagada: cancela en Stripe al final del período
 */
export const cancelSubscription = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user!.id;

    const subscription = await subscriptionService.getUserSubscription(userId);

    if (subscription.plan === 'FREE') {
      return res.status(400).json({ message: 'No puedes cancelar el plan gratuito' });
    }

    // Si está en TRIALING, volver a FREE inmediatamente (no hay Stripe)
    if (subscription.status === 'TRIALING') {
      // Eliminar conexiones de email (email sync es exclusivo PRO)
      try {
        await EmailSyncService.deleteAllUserEmailConnections(userId);
      } catch (emailError) {
        logger.warn(`[Subscriptions] Error eliminando conexiones de email:`, emailError);
      }

      await prisma.subscription.update({
        where: { userId },
        data: {
          plan: 'FREE',
          status: 'ACTIVE',
          trialEndsAt: null,
          trialStartedAt: null,
        }
      });

      logger.log(`✅ Trial cancelado, usuario ${userId} volvió a FREE`);

      return res.json({
        message: 'Período de prueba cancelado. Has vuelto al plan gratuito.',
        plan: 'FREE',
      });
    }

    // Suscripción pagada - cancelar en Stripe
    if (!subscription.stripeSubscriptionId) {
      return res.status(404).json({ message: 'No hay suscripción activa para cancelar' });
    }

    // Cancelar en Stripe
    await stripeService.cancelSubscription(subscription.stripeSubscriptionId);

    // Marcar como cancelada en la BD
    await subscriptionService.cancelSubscription(userId);

    res.json({
      message: 'Suscripción cancelada. Tendrás acceso hasta el final del período de facturación.',
      cancelAtPeriodEnd: true,
      currentPeriodEnd: subscription.currentPeriodEnd,
    });
  } catch (error: any) {
    logger.error('Error cancelando suscripción:', error);
    res.status(500).json({
      message: 'Error al cancelar suscripción',
      error: error.message
    });
  }
};

/**
 * Reactivar suscripción cancelada
 */
export const reactivateSubscription = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user!.id;

    const subscription = await subscriptionService.getUserSubscription(userId);

    if (!subscription.stripeSubscriptionId) {
      return res.status(404).json({ message: 'No hay suscripción para reactivar' });
    }

    if (!subscription.cancelAtPeriodEnd) {
      return res.status(400).json({ message: 'La suscripción no está cancelada' });
    }

    // Reactivar en Stripe
    await stripeService.reactivateSubscription(subscription.stripeSubscriptionId);

    // Reactivar en la BD
    await subscriptionService.reactivateSubscription(userId);

    res.json({
      message: 'Suscripción reactivada exitosamente',
      cancelAtPeriodEnd: false,
    });
  } catch (error: any) {
    logger.error('Error reactivando suscripción:', error);
    res.status(500).json({
      message: 'Error al reactivar suscripción',
      error: error.message
    });
  }
};

/**
 * Crear portal del cliente (para gestionar suscripción, métodos de pago, facturas)
 */
export const createCustomerPortal = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user!.id;

    const subscription = await subscriptionService.getUserSubscription(userId);

    if (!subscription.stripeCustomerId) {
      return res.status(404).json({ message: 'No tienes una cuenta de Stripe vinculada' });
    }

    const baseUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const returnUrl = `${baseUrl}/subscription`;

    const session = await stripeService.createCustomerPortal(
      subscription.stripeCustomerId,
      returnUrl
    );

    res.json({ url: session.url });
  } catch (error: any) {
    logger.error('Error creando portal de cliente:', error);
    res.status(500).json({
      message: 'Error al crear portal de cliente',
      error: error.message
    });
  }
};

/**
 * Cambiar plan de suscripción
 * - Si está en TRIALING: solo cambia el plan en BD (sin tocar Stripe)
 * - Si tiene suscripción pagada: cambia en Stripe con prorrateo
 */
export const changePlan = async (req: Request, res: Response) => {
  try {
    const { newPlan, billingPeriod = 'monthly' } = req.body as {
      newPlan: PlanType;
      billingPeriod?: BillingPeriod;
    };
    const userId = (req as any).user!.id;

    // Validar nuevo plan
    if (!newPlan || !['PREMIUM', 'PRO'].includes(newPlan)) {
      return res.status(400).json({ message: 'Plan inválido' });
    }

    // Validar período de facturación
    if (!['monthly', 'yearly'].includes(billingPeriod)) {
      return res.status(400).json({ message: 'Período de facturación inválido' });
    }

    const subscription = await subscriptionService.getUserSubscription(userId);

    if (subscription.plan === newPlan) {
      return res.status(400).json({ message: 'Ya tienes este plan' });
    }

    // Si está en TRIALING, solo cambiar el plan en la BD (sin Stripe)
    if (subscription.status === 'TRIALING') {
      // Si el usuario baja de PRO a PREMIUM (PLUS), eliminar conexiones de email
      if (subscription.plan === 'PRO' && newPlan === 'PREMIUM') {
        try {
          await EmailSyncService.deleteAllUserEmailConnections(userId);
          logger.log(`[Subscriptions] Conexiones de email eliminadas al bajar de PRO a PLUS`);
        } catch (emailError) {
          logger.warn(`[Subscriptions] Error eliminando conexiones de email:`, emailError);
        }
      }

      await prisma.subscription.update({
        where: { userId },
        data: { plan: newPlan }
      });

      logger.log(`✅ Plan cambiado en trial: ${subscription.plan} -> ${newPlan} para usuario ${userId}`);

      return res.json({
        message: `Plan cambiado a ${newPlan} exitosamente. Tu período de prueba continúa.`,
        newPlan,
        isTrialing: true,
        trialEndsAt: subscription.trialEndsAt,
      });
    }

    // Suscripción pagada - requiere Stripe
    if (!subscription.stripeSubscriptionId) {
      return res.status(404).json({ message: 'No tienes una suscripción activa' });
    }

    // Obtener el price ID correcto según plan y período
    const priceId = getPriceId(newPlan, billingPeriod);
    if (!priceId) {
      return res.status(400).json({ message: 'Plan no disponible para este período' });
    }

    // Cambiar plan en Stripe
    await stripeService.changeSubscriptionPlan(
      subscription.stripeSubscriptionId,
      priceId
    );

    res.json({
      message: `Plan cambiado a ${newPlan} (${billingPeriod}) exitosamente`,
      newPlan,
      billingPeriod,
    });
  } catch (error: any) {
    logger.error('Error cambiando plan:', error);
    res.status(500).json({
      message: 'Error al cambiar plan',
      error: error.message
    });
  }
};

/**
 * Obtener historial de pagos
 */
export const getPaymentHistory = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user!.id;
    // Sanitizar límite máximo de 20
    const limitNum = sanitizeLimit(req.query.limit as string, PAGINATION.MAX_LIMITS.SUBSCRIPTIONS, 10);

    const payments = await subscriptionService.getPaymentHistory(userId, limitNum);

    res.json({ payments });
  } catch (error: any) {
    logger.error('Error obteniendo historial de pagos:', error);
    res.status(500).json({
      message: 'Error al obtener historial',
      error: error.message
    });
  }
};

/**
 * Verificar estado de sesión de checkout Y sincronizar suscripción
 */
export const checkCheckoutSession = async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const userId = (req as any).user!.id;

    logger.log(`🔄 Verificando sesión ${sessionId} para usuario ${userId}`);

    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.metadata?.userId !== userId) {
      return res.status(403).json({ message: 'No autorizado' });
    }

    // Si el checkout se completó y hay suscripción, sincronizar
    if (session.status === 'complete' && session.subscription) {
      logger.log(`✅ Sesión completada, sincronizando suscripción ${session.subscription}`);

      try {
        const subscription = await stripe.subscriptions.retrieve(
          session.subscription as string
        );

        // Determinar el plan basado en el price ID usando el helper
        const priceId = subscription.items.data[0].price.id;
        const planInfo = getPlanFromPriceId(priceId);

        let plan: 'PREMIUM' | 'PRO' = 'PREMIUM';
        let billingPeriod: BillingPeriod = 'monthly';

        if (planInfo) {
          plan = planInfo.plan as 'PREMIUM' | 'PRO';
          billingPeriod = planInfo.billingPeriod;
          logger.log(`📋 Plan detectado: ${plan} (${billingPeriod})`);
        }

        // Actualizar suscripción en BD. Mismo helper que el webhook: leer el
        // período del objeto raíz daba undefined y caía a "30 días" fijos.
        const { currentPeriodStart, currentPeriodEnd } = getSubscriptionPeriod(subscription);

        await subscriptionService.updateSubscriptionAfterPayment(userId, plan, {
          stripeCustomerId: subscription.customer as string,
          stripeSubscriptionId: subscription.id,
          stripePriceId: priceId,
          currentPeriodStart,
          currentPeriodEnd,
          trialEndsAt: subscription.trial_end
            ? new Date(subscription.trial_end * 1000)
            : null,
        });

        // Actualizar status
        const statusMap: { [key: string]: any } = {
          'active': 'ACTIVE',
          'trialing': 'TRIALING',
        };
        const status = statusMap[subscription.status] || 'ACTIVE';
        await subscriptionService.updateSubscriptionStatus(userId, status);

        logger.log(`✅ Suscripción sincronizada: ${plan} (${status})`);
      } catch (syncError) {
        logger.error('❌ Error sincronizando suscripción:', syncError);
      }
    }

    res.json({
      status: session.status,
      paymentStatus: session.payment_status,
      subscription: session.subscription,
    });
  } catch (error: any) {
    logger.error('Error verificando sesión:', error);
    res.status(500).json({
      message: 'Error al verificar sesión',
      error: error.message
    });
  }
};
