import { Request, Response } from 'express';
import { stripeService } from '../services/stripeService';
import { subscriptionService } from '../services/subscriptionService';
import { PLANS, PlanType, stripe } from '../config/stripe';

/**
 * Crear sesión de checkout para upgrade de plan
 */
export const createCheckout = async (req: Request, res: Response) => {
  try {
    const { plan } = req.body as { plan: PlanType };
    const userId = (req as any).user!.id;

    // Validar plan
    if (!plan || !['PREMIUM', 'PRO'].includes(plan)) {
      return res.status(400).json({ message: 'Plan inválido' });
    }

    const planConfig = PLANS[plan];
    if (!planConfig.stripePriceId) {
      return res.status(400).json({ message: 'Plan no disponible' });
    }

    // Verificar que no tenga ya una suscripción activa del mismo plan
    const currentSubscription = await subscriptionService.getUserSubscription(userId);
    if (currentSubscription.plan === plan && currentSubscription.status === 'ACTIVE') {
      return res.status(400).json({ message: 'Ya tienes este plan activo' });
    }

    const baseUrl = process.env.FRONTEND_URL || 'http://localhost:3000';

    // Crear sesión de checkout
    const session = await stripeService.createCheckoutSession(
      userId,
      planConfig.stripePriceId,
      `${baseUrl}/subscription/success?session_id={CHECKOUT_SESSION_ID}`,
      `${baseUrl}/subscription/canceled`
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
    const plans = Object.entries(PLANS).map(([key, value]) => ({
      id: key,
      ...value,
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
    const { newPlan } = req.body as { newPlan: PlanType };
    const userId = (req as any).user!.id;

    // Validar nuevo plan
    if (!newPlan || !['PREMIUM', 'PRO'].includes(newPlan)) {
      return res.status(400).json({ message: 'Plan inválido' });
    }

    const subscription = await subscriptionService.getUserSubscription(userId);

    if (!subscription.stripeSubscriptionId) {
      return res.status(404).json({ message: 'No tienes una suscripción activa' });
    }

    if (subscription.plan === newPlan) {
      return res.status(400).json({ message: 'Ya tienes este plan' });
    }

    const newPlanConfig = PLANS[newPlan];
    if (!newPlanConfig.stripePriceId) {
      return res.status(400).json({ message: 'Plan no disponible' });
    }

    // Cambiar plan en Stripe
    await stripeService.changeSubscriptionPlan(
      subscription.stripeSubscriptionId,
      newPlanConfig.stripePriceId
    );

    res.json({
      message: `Plan cambiado a ${newPlan} exitosamente`,
      newPlan,
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
 * Verificar estado de sesión de checkout
 */
export const checkCheckoutSession = async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const userId = (req as any).user!.id;

    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.metadata?.userId !== userId) {
      return res.status(403).json({ message: 'No autorizado' });
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
