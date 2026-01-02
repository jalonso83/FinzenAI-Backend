import { Request, Response } from 'express';
import { stripeService } from '../services/stripeService';
import { subscriptionService } from '../services/subscriptionService';
import { PLANS, PlanType, BillingPeriod, getPriceId, getPlanFromPriceId, stripe } from '../config/stripe';

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
    console.error('Error creando checkout:', error);
    res.status(500).json({
      message: 'Error al crear sesión de pago',
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
    console.error('Error obteniendo suscripción:', error);
    res.status(500).json({
      message: 'Error al obtener suscripción',
      error: error.message
    });
  }
};

/**
 * Obtener todos los planes disponibles
 */
export const getPlans = async (req: Request, res: Response) => {
  try {
    // Excluir PREMIUM del response (es un alias de PLUS)
    const plans = Object.entries(PLANS)
      .filter(([key]) => key !== 'PREMIUM')
      .map(([key, value]) => ({
        id: key,
        name: value.name,
        price: value.price,
        savings: (value as any).savings || null,
        limits: value.limits,
        features: value.features,
      }));

    res.json({ plans });
  } catch (error: any) {
    console.error('Error obteniendo planes:', error);
    res.status(500).json({
      message: 'Error al obtener planes',
      error: error.message
    });
  }
};

/**
 * Cancelar suscripción (al final del período)
 */
export const cancelSubscription = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user!.id;

    const subscription = await subscriptionService.getUserSubscription(userId);

    if (!subscription.stripeSubscriptionId) {
      return res.status(404).json({ message: 'No hay suscripción activa para cancelar' });
    }

    if (subscription.plan === 'FREE') {
      return res.status(400).json({ message: 'No puedes cancelar el plan gratuito' });
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
    console.error('Error cancelando suscripción:', error);
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
    console.error('Error reactivando suscripción:', error);
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
    console.error('Error creando portal de cliente:', error);
    res.status(500).json({
      message: 'Error al crear portal de cliente',
      error: error.message
    });
  }
};

/**
 * Cambiar plan de suscripción
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

    if (!subscription.stripeSubscriptionId) {
      return res.status(404).json({ message: 'No tienes una suscripción activa' });
    }

    if (subscription.plan === newPlan) {
      return res.status(400).json({ message: 'Ya tienes este plan' });
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
    console.error('Error cambiando plan:', error);
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
    const limit = parseInt(req.query.limit as string) || 10;

    const payments = await subscriptionService.getPaymentHistory(userId, limit);

    res.json({ payments });
  } catch (error: any) {
    console.error('Error obteniendo historial de pagos:', error);
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

    console.log(`🔄 Verificando sesión ${sessionId} para usuario ${userId}`);

    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.metadata?.userId !== userId) {
      return res.status(403).json({ message: 'No autorizado' });
    }

    // Si el checkout se completó y hay suscripción, sincronizar
    if (session.status === 'complete' && session.subscription) {
      console.log(`✅ Sesión completada, sincronizando suscripción ${session.subscription}`);

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
          console.log(`📋 Plan detectado: ${plan} (${billingPeriod})`);
        }

        // Actualizar suscripción en BD
        const sub = subscription as any;
        const currentPeriodStart = sub.current_period_start
          ? new Date(sub.current_period_start * 1000)
          : new Date();
        const currentPeriodEnd = sub.current_period_end
          ? new Date(sub.current_period_end * 1000)
          : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

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

        console.log(`✅ Suscripción sincronizada: ${plan} (${status})`);
      } catch (syncError) {
        console.error('❌ Error sincronizando suscripción:', syncError);
      }
    }

    res.json({
      status: session.status,
      paymentStatus: session.payment_status,
      subscription: session.subscription,
    });
  } catch (error: any) {
    console.error('Error verificando sesión:', error);
    res.status(500).json({
      message: 'Error al verificar sesión',
      error: error.message
    });
  }
};
