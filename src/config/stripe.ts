import Stripe from 'stripe';

// Inicializar Stripe
export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
  apiVersion: '2025-10-29.clover',
  typescript: true,
});

export const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';

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
      budgets: 3,
      goals: 2,
      zenioQueries: 10,
      advancedReports: false,
      exportData: false,
    },
    features: [
      'Transacciones ilimitadas',
      'Hasta 3 presupuestos activos',
      'Hasta 2 metas de ahorro',
      'Asesoría financiera con IA (10 consultas/mes)',
      'Reportes básicos',
      'Gamificación básica',
    ],
  },
  PREMIUM: {
    name: 'Plus', // Se muestra como "Plus" al usuario, pero internamente es PREMIUM
    price: {
      monthly: 4.99,
      yearly: 49.99,
    },
    stripePriceId: {
      monthly: process.env.STRIPE_PLUS_MONTHLY_PRICE_ID || '',
      yearly: process.env.STRIPE_PLUS_YEARLY_PRICE_ID || '',
    },
    savings: {
      yearly: 9.89, // Ahorro anual (17%)
      percentage: 17,
    },
    limits: {
      budgets: -1, // -1 = ilimitado
      goals: -1,
      zenioQueries: -1,
      advancedReports: true,
      exportData: true,
    },
    features: [
      'Todo lo de Gratis',
      'Presupuestos ilimitados',
      'Metas ilimitadas',
      'Asesoría financiera con IA ilimitada',
      'Reportes avanzados con IA',
      'Análisis de tendencias',
      'Alertas personalizadas',
      'Sin publicidad',
    ],
  },
  PRO: {
    name: 'Pro',
    price: {
      monthly: 9.99,
      yearly: 99.99,
    },
    stripePriceId: {
      monthly: process.env.STRIPE_PRO_MONTHLY_PRICE_ID || '',
      yearly: process.env.STRIPE_PRO_YEARLY_PRICE_ID || '',
    },
    savings: {
      yearly: 19.89, // Ahorro anual (17%)
      percentage: 17,
    },
    limits: {
      budgets: -1,
      goals: -1,
      zenioQueries: -1,
      advancedReports: true,
      exportData: true,
      bankIntegration: true,
    },
    features: [
      'Todo lo de Plus',
      'Detección automática de gastos desde tu correo',
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
