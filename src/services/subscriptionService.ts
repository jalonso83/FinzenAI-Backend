import { prisma } from '../lib/prisma';
import { PLANS, PlanType } from '../config/stripe';
import { aterrizajeTrial } from '../config/trial';
import { SubscriptionPlan, SubscriptionStatus } from '@prisma/client';

import { logger } from '../utils/logger';

/** Orden de los planes, para poder compararlos. Mismo criterio que `requirePlan`. */
const JERARQUIA_DE_PLAN: Record<string, number> = { FREE: 0, PREMIUM: 1, PRO: 2 };
export function jerarquiaDePlan(plan: string): number {
  return JERARQUIA_DE_PLAN[plan] ?? 0;
}

export class SubscriptionService {
  /**
   * Obtener suscripción de un usuario
   */
  async getUserSubscription(userId: string) {
    try {
      let subscription = await prisma.subscription.findUnique({
        where: { userId },
      });

      // Si no tiene suscripción, crear una FREE por defecto
      if (!subscription) {
        subscription = await this.createFreeSubscription(userId);
      }

      let plan = subscription.plan as PlanType;

      // Verificar que el plan existe en PLANS, si no, usar FREE
      if (!PLANS[plan]) {
        logger.warn(`Plan inválido detectado: ${plan} para usuario ${userId}. Reseteando a FREE.`);
        // Auto-reparar: actualizar a FREE en la BD
        subscription = await prisma.subscription.update({
          where: { userId },
          data: {
            plan: 'FREE',
            status: 'ACTIVE',
            stripeSubscriptionId: null,
            stripePriceId: null,
          },
        });
        plan = 'FREE' as PlanType;
      }

      // Auto-reparar: FREE + CANCELED → FREE + ACTIVE
      // Un usuario en plan FREE no debería tener status CANCELED
      if (subscription.plan === 'FREE' && subscription.status === 'CANCELED') {
        logger.warn(`Estado inválido FREE+CANCELED detectado para usuario ${userId}. Reparando a ACTIVE.`);
        subscription = await prisma.subscription.update({
          where: { userId },
          data: { status: 'ACTIVE' },
        });
      }

      // ─── Concesión manual vigente ──────────────────────────────────────────
      // Un plan regalado por nosotros gana sobre el real mientras no caduque.
      // Se resuelve AQUÍ, y no en cada llamador, porque este método es el único
      // sitio por el que pasan todos los controles de plan: `requirePlan`,
      // `checkBudgetLimit`, `checkGoalLimit`, `checkZenioLimit`, `canUseFeature`
      // y `checkResourceLimit`. Resolverlo en un solo punto es lo que hace que
      // la concesión funcione en toda la app sin tocar nada más.
      //
      // Solo sube, nunca baja: si el usuario ya paga un plan mejor que el
      // regalado, se queda con el suyo. Regalar Plus a quien tiene Pro no puede
      // quitarle Pro.
      const concesionVigente =
        subscription.grantedPlan != null &&
        subscription.grantedUntil != null &&
        subscription.grantedUntil > new Date() &&
        PLANS[subscription.grantedPlan as PlanType] != null;

      const planReal = plan;
      if (concesionVigente && jerarquiaDePlan(subscription.grantedPlan as PlanType) > jerarquiaDePlan(plan)) {
        plan = subscription.grantedPlan as PlanType;
      }

      // ─── Aterrizaje suave tras el trial ────────────────────────────────────
      // Vencer el trial es hoy un apagón: se vuelve a los topes de FREE de golpe
      // y de los 16 que llegaron a ese momento no sobrevivió ninguno. Esto deja
      // montado el poder ablandarlo —conservar algo por encima de FREE— sin otro
      // ciclo de tienda: se enciende con una variable de entorno.
      //
      // Va DESPUÉS de la concesión y solo toca a quien está en FREE, así que no
      // puede rebajar a nadie: ni a quien paga, ni a quien tiene un regalo
      // vigente. Solo sube los topes de quien ya salió del trial.
      const aterrizaje = aterrizajeTrial();
      const aterrizoDelTrial =
        plan === 'FREE' && subscription.trialEndedAt != null && aterrizaje.activo;

      const limits = aterrizoDelTrial
        ? {
            ...PLANS[plan].limits,
            budgets: Math.max(PLANS.FREE.limits.budgets, aterrizaje.budgets),
            goals: Math.max(PLANS.FREE.limits.goals, aterrizaje.goals),
            zenioQueries: Math.max(PLANS.FREE.limits.zenioQueries, aterrizaje.zenioQueries),
          }
        : PLANS[plan].limits;

      const features = PLANS[plan].features;

      // Verificar si necesitamos resetear el contador de Zenio (nuevo mes)
      const zenioUsage = await this.getZenioUsage(userId, subscription);

      // Obtener información del usuario para saber si puede usar trial
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { hasUsedTrial: true },
      });
      const canUseTrial = !user?.hasUsedTrial;

      return {
        ...subscription,
        // `plan` se pisa a propósito con el EFECTIVO: es lo que leen la app y
        // los middlewares para decidir qué puede hacer el usuario, y durante una
        // concesión lo que puede hacer es lo del plan regalado. El de la BD
        // queda expuesto aparte como `planReal` para el panel de admin y para
        // no perder de vista lo que de verdad paga.
        plan,
        planReal,
        grantActive: concesionVigente && plan !== planReal,
        // Lo lee la pantalla de vencimiento para saber si pintar "conservas X"
        // o el apagón seco. La app no decide esto: pregunta.
        softLandingActive: aterrizoDelTrial,
        limits,
        features,
        planDetails: PLANS[plan],
        zenioUsage,
        canUseTrial,
      };
    } catch (error) {
      logger.error('Error obteniendo suscripción:', error);
      throw new Error('No se pudo obtener la suscripción');
    }
  }

  /**
   * Obtener uso actual de Zenio (con reset automático mensual)
   */
  async getZenioUsage(userId: string, subscription?: any) {
    try {
      if (!subscription) {
        subscription = await prisma.subscription.findUnique({
          where: { userId },
        });
      }

      if (!subscription) {
        return { used: 0, limit: 10, remaining: 10 };
      }

      const plan = subscription.plan as PlanType;
      // El tope de Zenio se calcula aquí aparte de `limits`, así que el
      // aterrizaje suave hay que aplicarlo también en este punto: si no, la
      // pantalla diría "25 consultas" y el contador seguiría cortando en 15.
      const aterrizaje = aterrizajeTrial();
      const zenioLimit =
        plan === 'FREE' && subscription.trialEndedAt != null && aterrizaje.activo
          ? Math.max(PLANS.FREE.limits.zenioQueries, aterrizaje.zenioQueries)
          : (PLANS[plan]?.limits?.zenioQueries ?? 10);

      // Verificar si necesitamos resetear (nuevo mes)
      const now = new Date();
      const resetAt = new Date(subscription.zenioQueriesResetAt);
      const currentMonth = now.getMonth();
      const currentYear = now.getFullYear();
      const resetMonth = resetAt.getMonth();
      const resetYear = resetAt.getFullYear();

      let currentCount = subscription.zenioQueriesUsed;

      // Si cambió el mes, resetear contador
      if (currentYear > resetYear || (currentYear === resetYear && currentMonth > resetMonth)) {
        await prisma.subscription.update({
          where: { userId },
          data: {
            zenioQueriesUsed: 0,
            zenioQueriesResetAt: now,
          },
        });
        currentCount = 0;
      }

      return {
        used: currentCount,
        limit: zenioLimit,
        remaining: zenioLimit === -1 ? -1 : Math.max(0, zenioLimit - currentCount),
      };
    } catch (error) {
      logger.error('Error obteniendo uso de Zenio:', error);
      return { used: 0, limit: 10, remaining: 10 };
    }
  }

  /**
   * Crear suscripción FREE por defecto
   */
  async createFreeSubscription(userId: string) {
    try {
      const subscription = await prisma.subscription.create({
        data: {
          userId,
          plan: SubscriptionPlan.FREE,
          status: SubscriptionStatus.ACTIVE,
        },
      });

      logger.log(`✅ Suscripción FREE creada para usuario ${userId}`);
      return subscription;
    } catch (error) {
      logger.error('Error creando suscripción FREE:', error);
      throw new Error('No se pudo crear la suscripción');
    }
  }

  /**
   * Verificar si el usuario puede usar una feature
   */
  async canUseFeature(userId: string, feature: string): Promise<boolean> {
    try {
      const subscription = await this.getUserSubscription(userId);
      const limits = subscription.limits as any;

      return limits[feature] === true || limits[feature] === -1;
    } catch (error) {
      logger.error('Error verificando feature:', error);
      return false;
    }
  }

  /**
   * Verificar límite de un recurso (presupuestos, metas, etc)
   */
  async checkResourceLimit(
    userId: string,
    resourceType: 'budgets' | 'goals' | 'zenioQueries',
    currentCount: number
  ): Promise<{ allowed: boolean; limit: number; remaining: number }> {
    try {
      const subscription = await this.getUserSubscription(userId);
      const limits = subscription.limits as any;
      const limit = limits[resourceType];

      // -1 significa ilimitado
      if (limit === -1) {
        return {
          allowed: true,
          limit: -1,
          remaining: -1,
        };
      }

      const allowed = currentCount < limit;
      const remaining = Math.max(0, limit - currentCount);

      return {
        allowed,
        limit,
        remaining,
      };
    } catch (error) {
      logger.error('Error verificando límite de recurso:', error);
      return { allowed: false, limit: 0, remaining: 0 };
    }
  }

  /**
   * Actualizar suscripción después de un pago exitoso
   */
  async updateSubscriptionAfterPayment(
    userId: string,
    plan: SubscriptionPlan,
    stripeData: {
      stripeCustomerId: string;
      stripeSubscriptionId: string;
      stripePriceId: string;
      currentPeriodStart: Date;
      currentPeriodEnd: Date;
      trialEndsAt?: Date | null;
      /**
       * Estado de cancelación programada, tal como lo reporta Stripe
       * (`cancel_at_period_end`). Quien llame DEBE pasarlo si lo tiene.
       *
       * Antes esto no era un parámetro: el `update` forzaba `false` siempre. El
       * efecto era que una cancelación se deshacía sola en nuestra base a los
       * pocos segundos de hacerla — el usuario cancelaba, Stripe emitía
       * `customer.subscription.updated`, y este upsert la borraba. La app le
       * seguía diciendo que su plan se renovaba, el botón de reactivar le
       * respondía "la suscripción no está cancelada", y el churn no se veía
       * venir. El cobro nunca se vio afectado porque Stripe sí guardaba bien la
       * cancelación; lo que estaba mal era nuestra copia.
       *
       * Si no viene (undefined), NO se toca el campo: es mejor conservar lo que
       * haya en la base que volver a asumir un valor.
       */
      cancelAtPeriodEnd?: boolean;
    }
  ) {
    try {
      const { cancelAtPeriodEnd, ...datosStripe } = stripeData;

      const subscription = await prisma.subscription.upsert({
        where: { userId },
        create: {
          userId,
          plan,
          status: SubscriptionStatus.ACTIVE,
          ...datosStripe,
          cancelAtPeriodEnd: cancelAtPeriodEnd ?? false,
        },
        update: {
          plan,
          status: SubscriptionStatus.ACTIVE,
          ...datosStripe,
          // Solo se escribe si el llamador lo sabe. Ver la nota del parámetro.
          ...(cancelAtPeriodEnd !== undefined ? { cancelAtPeriodEnd } : {}),
        },
      });

      logger.log(`✅ Suscripción actualizada a ${plan} para usuario ${userId}`);
      return subscription;
    } catch (error) {
      logger.error('Error actualizando suscripción:', error);
      throw new Error('No se pudo actualizar la suscripción');
    }
  }

  /**
   * Cancelar suscripción (marcar para cancelar al final del período)
   */
  async cancelSubscription(userId: string) {
    try {
      const subscription = await prisma.subscription.update({
        where: { userId },
        data: {
          cancelAtPeriodEnd: true,
        },
      });

      logger.log(`✅ Suscripción marcada para cancelación: usuario ${userId}`);
      return subscription;
    } catch (error) {
      logger.error('Error cancelando suscripción:', error);
      throw new Error('No se pudo cancelar la suscripción');
    }
  }

  /**
   * Reactivar suscripción cancelada
   */
  async reactivateSubscription(userId: string) {
    try {
      const subscription = await prisma.subscription.update({
        where: { userId },
        data: {
          cancelAtPeriodEnd: false,
        },
      });

      logger.log(`✅ Suscripción reactivada: usuario ${userId}`);
      return subscription;
    } catch (error) {
      logger.error('Error reactivando suscripción:', error);
      throw new Error('No se pudo reactivar la suscripción');
    }
  }

  /**
   * Downgrade a FREE después de cancelación
   */
  async downgradeToFree(userId: string) {
    try {
      const subscription = await prisma.subscription.update({
        where: { userId },
        data: {
          plan: SubscriptionPlan.FREE,
          status: SubscriptionStatus.ACTIVE,
          stripeSubscriptionId: null,
          stripePriceId: null,
          currentPeriodStart: null,
          currentPeriodEnd: null,
          cancelAtPeriodEnd: false,
        },
      });

      logger.log(`✅ Usuario ${userId} degradado a plan FREE`);
      return subscription;
    } catch (error) {
      logger.error('Error degradando a FREE:', error);
      throw new Error('No se pudo degradar el plan');
    }
  }

  /**
   * Actualizar estado de suscripción
   */
  async updateSubscriptionStatus(userId: string, status: SubscriptionStatus) {
    try {
      const subscription = await prisma.subscription.update({
        where: { userId },
        data: { status },
      });

      logger.log(`✅ Estado de suscripción actualizado: usuario ${userId} -> ${status}`);
      return subscription;
    } catch (error) {
      logger.error('Error actualizando estado de suscripción:', error);
      throw new Error('No se pudo actualizar el estado');
    }
  }

  /**
   * Registrar pago
   */
  async recordPayment(data: {
    userId: string;
    subscriptionId?: string;
    amount: number;
    currency: string;
    status: 'SUCCEEDED' | 'FAILED' | 'PENDING' | 'REFUNDED' | 'CANCELED';
    stripePaymentIntentId?: string;
    stripeInvoiceId?: string;
    description?: string;
  }) {
    try {
      // Una factura de Stripe = UNA fila, no una por intento.
      //
      // Esto era un `create` y reventaba con P2002: Stripe reintenta un cobro
      // fallido hasta 8 veces y cada intento dispara el webhook con la MISMA
      // factura. El primero creaba la fila y los siguientes fallaban, el
      // webhook devolvía error —con lo que Stripe reintentaba todavía más— y
      // todo lo que iba después de registrar el pago (degradar el plan, avisar
      // al usuario) se quedaba sin ejecutar.
      //
      // Con `upsert` el reintento actualiza en vez de romper. Y de paso queda
      // bien el caso de recuperación: si la factura falla y luego se cobra,
      // Stripe manda los dos eventos y la fila termina en SUCCEEDED en vez de
      // dejar un FAILED huérfano al lado.
      const clave = data.stripeInvoiceId
        ? { stripeInvoiceId: data.stripeInvoiceId }
        : data.stripePaymentIntentId
          ? { stripePaymentIntentId: data.stripePaymentIntentId }
          : null;

      // Sin identificador de Stripe no hay con qué deduplicar (pagos manuales,
      // otros proveedores): se crea y ya.
      const payment = clave
        ? await prisma.payment.upsert({
            where: clave as any,
            update: {
              status: data.status,
              amount: data.amount,
              currency: data.currency,
              description: data.description,
              // El intento de pago SÍ puede cambiar entre reintentos de la
              // misma factura; el resto de campos no se tocan.
              stripePaymentIntentId: data.stripePaymentIntentId,
            },
            create: data,
          })
        : await prisma.payment.create({ data });

      logger.log(`✅ Pago registrado: ${payment.id} - ${data.status}`);
      return payment;
    } catch (error) {
      logger.error('Error registrando pago:', error);
      throw new Error('No se pudo registrar el pago');
    }
  }

  /**
   * Obtener historial de pagos
   */
  async getPaymentHistory(userId: string, limit: number = 10) {
    try {
      const payments = await prisma.payment.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: limit,
      });

      return payments;
    } catch (error) {
      logger.error('Error obteniendo historial de pagos:', error);
      throw new Error('No se pudo obtener el historial');
    }
  }

  /**
   * Obtener estadísticas de suscripciones (para admin)
   */
  async getSubscriptionStats() {
    try {
      const stats = await prisma.subscription.groupBy({
        by: ['plan'],
        _count: true,
      });

      const activeByPlan = await prisma.subscription.groupBy({
        by: ['plan'],
        where: { status: SubscriptionStatus.ACTIVE },
        _count: true,
      });

      return {
        totalByPlan: stats,
        activeByPlan,
      };
    } catch (error) {
      logger.error('Error obteniendo estadísticas:', error);
      throw new Error('No se pudieron obtener las estadísticas');
    }
  }
}

export const subscriptionService = new SubscriptionService();
