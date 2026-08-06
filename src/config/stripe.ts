import Stripe from 'stripe';
import { ENV } from './env';

// Inicializar Stripe con validación
export const stripe = new Stripe(ENV.STRIPE_SECRET_KEY, {
  apiVersion: '2025-10-29.clover',
  typescript: true,
});

export const STRIPE_WEBHOOK_SECRET = ENV.STRIPE_WEBHOOK_SECRET;

// Tipo para período de facturación
export type BillingPeriod = 'monthly' | 'yearly';

// Definición de planes y límites
export const PLANS = {
  FREE: {
    name: 'Gratis',
    price: {
      monthly: 0,
      yearly: 0,
    },
    stripePriceId: {
      monthly: null,
      yearly: null,
    },
    limits: {
      budgets: 4,
      goals: 2,
      zenioQueries: 15,
      reminders: 2, // Máximo 2 recordatorios de pago activos
      budgetAlerts: false, // Sin alertas de umbral de presupuesto
      textToSpeech: false, // Sin TTS para respuestas de Zenio
      advancedReports: false,
      exportData: false,
      bankIntegration: false,
      antExpenseAnalysis: 'basic' as const, // Solo top 3 gastos hormiga
      antExpenseAlerts: false, // Sin alertas automáticas de gastos hormiga
      advancedCalculators: false, // Sin acceso a Skip vs Save Challenge
    },
    features: [
      // OJO: estos textos deben coincidir con `limits` de arriba — es lo que el
      // usuario ve en la pantalla de planes. Decían 2 presupuestos y 1 meta
      // cuando el sistema ya permitía 4 y 2 (corregido 2026-07-31).
      'Transacciones ilimitadas',
      'Hasta 4 presupuestos activos',
      'Hasta 2 metas de ahorro',
      'Hasta 2 recordatorios de pago',
      'Asesoría financiera con IA (15 consultas/mes)',
      'Reportes básicos',
      'Gamificación básica',
      'Detector de gastos hormiga (básico)',
      'Calculadoras financieras básicas',
    ],
  },
  PREMIUM: {
    name: 'Plus', // Se muestra como "Plus" al usuario, pero internamente es PREMIUM
    price: {
      monthly: 4.99,
      yearly: 49.99,
    },
    stripePriceId: {
      monthly: ENV.STRIPE_PLUS_MONTHLY_PRICE_ID,
      yearly: ENV.STRIPE_PLUS_YEARLY_PRICE_ID,
    },
    savings: {
      yearly: 9.89, // Ahorro anual (17%)
      percentage: 17,
    },
    limits: {
      budgets: -1, // -1 = ilimitado
      goals: -1,
      zenioQueries: -1,
      reminders: -1, // Recordatorios ilimitados
      budgetAlerts: true, // Alertas de umbral de presupuesto
      textToSpeech: true, // TTS para respuestas de Zenio
      advancedReports: true,
      exportData: true,
      bankIntegration: false,
      antExpenseAnalysis: 'full' as const, // Análisis completo con recomendaciones
      antExpenseAlerts: false, // Sin alertas automáticas (solo PRO)
      advancedCalculators: true, // Acceso a Skip vs Save Challenge
    },
    features: [
      'Todo lo de Gratis',
      'Presupuestos ilimitados',
      'Metas ilimitadas',
      'Recordatorios de pago ilimitados',
      'Alertas de umbral en presupuestos',
      'Zenio con voz (Text-to-Speech)',
      'Asesoría financiera con IA ilimitada',
      'Reportes avanzados con IA',
      'Análisis de tendencias',
      'Alertas personalizadas',
      'Sin publicidad',
      'Detector de gastos hormiga completo',
      'Calculadoras avanzadas (Skip vs Save)',
    ],
  },
  PRO: {
    name: 'Pro',
    price: {
      monthly: 9.99,
      yearly: 99.99,
    },
    stripePriceId: {
      monthly: ENV.STRIPE_PRO_MONTHLY_PRICE_ID,
      yearly: ENV.STRIPE_PRO_YEARLY_PRICE_ID,
    },
    savings: {
      yearly: 19.89, // Ahorro anual (17%)
      percentage: 17,
    },
    limits: {
      budgets: -1,
      goals: -1,
      zenioQueries: -1,
      reminders: -1, // Recordatorios ilimitados
      budgetAlerts: true, // Alertas de umbral de presupuesto
      textToSpeech: true, // TTS para respuestas de Zenio
      advancedReports: true,
      exportData: true,
      bankIntegration: true, // Exclusivo PRO: Email Sync
      antExpenseAnalysis: 'full' as const, // Análisis completo con recomendaciones
      antExpenseAlerts: true, // Exclusivo PRO: Alertas automáticas semanales y mensuales
      advancedCalculators: true, // Acceso a Skip vs Save Challenge
    },
    features: [
      'Todo lo de Plus',
      'Detección automática de gastos desde tu correo',
      'Alertas automáticas de gastos hormiga',
      'Proyecciones de inversión',
      'Acceso anticipado a nuevas features',
    ],
  },
} as const;

export type PlanType = keyof typeof PLANS;

// Helper para obtener el price ID según el plan y período
export function getPriceId(plan: PlanType, billingPeriod: BillingPeriod): string | null {
  const planConfig = PLANS[plan];
  if (!planConfig || !planConfig.stripePriceId) return null;
  return planConfig.stripePriceId[billingPeriod] || null;
}

/**
 * Período de facturación vigente de una suscripción de Stripe.
 *
 * OJO — por qué existe este helper (bug encontrado 2026-08-05):
 * Desde la API `2025-03-31.basil`, Stripe MOVIÓ `current_period_start` y
 * `current_period_end` del objeto Subscription a sus ITEMS (una suscripción
 * puede tener items con ciclos distintos, así que la fecha dejó de tener
 * sentido a nivel de suscripción). Como aquí usamos `2025-10-29.clover`, leerlos
 * del objeto raíz devolvía `undefined` SIEMPRE.
 *
 * El código viejo tapaba eso con `?? Date.now() + 30 días`, así que TODAS las
 * suscripciones quedaban guardadas con un período de 30 días anclado al momento
 * del webhook. A un cliente anual eso le recortaba 11 meses en nuestra BD (real:
 * pagó un año en abril y la fila decía que vencía en mayo) y hacía que figurara
 * como churn en las métricas del panel.
 *
 * Orden de resolución:
 *   1. Los items (correcto en API >= 2025-03-31)
 *   2. El objeto raíz (compatibilidad con versiones viejas)
 *   3. Derivado del `interval` del precio — NUNCA asumir mensual: si el plan es
 *      anual, sumar un año. Se usa aritmética de calendario, no "+30 días".
 */
export function getSubscriptionPeriod(subscription: Stripe.Subscription): {
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
} {
  const item = subscription.items?.data?.[0];

  // Los typings varían entre versiones de la API; leemos de forma defensiva.
  const rawItem = item as unknown as {
    current_period_start?: number;
    current_period_end?: number;
  } | undefined;
  const rawSub = subscription as unknown as {
    current_period_start?: number;
    current_period_end?: number;
  };

  const startUnix = rawItem?.current_period_start ?? rawSub.current_period_start;
  const endUnix = rawItem?.current_period_end ?? rawSub.current_period_end;

  const currentPeriodStart = startUnix ? new Date(startUnix * 1000) : new Date();

  if (endUnix) {
    return { currentPeriodStart, currentPeriodEnd: new Date(endUnix * 1000) };
  }

  // Último recurso: derivar del intervalo del precio. Mejor esto que asumir un mes.
  const recurring = item?.price?.recurring;
  const interval = recurring?.interval ?? 'month';
  const count = recurring?.interval_count ?? 1;

  const end = new Date(currentPeriodStart);
  switch (interval) {
    case 'year':
      end.setUTCFullYear(end.getUTCFullYear() + count);
      break;
    case 'week':
      end.setUTCDate(end.getUTCDate() + 7 * count);
      break;
    case 'day':
      end.setUTCDate(end.getUTCDate() + count);
      break;
    case 'month':
    default:
      end.setUTCMonth(end.getUTCMonth() + count);
      break;
  }

  return { currentPeriodStart, currentPeriodEnd: end };
}

// Helper para obtener el plan desde un price ID
export function getPlanFromPriceId(priceId: string): { plan: PlanType; billingPeriod: BillingPeriod } | null {
  for (const [planKey, planConfig] of Object.entries(PLANS)) {
    if (planConfig.stripePriceId) {
      if (planConfig.stripePriceId.monthly === priceId) {
        return { plan: planKey as PlanType, billingPeriod: 'monthly' };
      }
      if (planConfig.stripePriceId.yearly === priceId) {
        return { plan: planKey as PlanType, billingPeriod: 'yearly' };
      }
    }
  }
  return null;
}
