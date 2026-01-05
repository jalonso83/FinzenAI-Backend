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
      budgets: 2,
      goals: 1,
      zenioQueries: 15,
      reminders: 2, // Máximo 2 recordatorios de pago activos
      budgetAlerts: false, // Sin alertas de umbral de presupuesto
      textToSpeech: false, // Sin TTS para respuestas de Zenio
      advancedReports: false,
      exportData: false,
      bankIntegration: false,
      antExpenseAnalysis: 'basic' as const, // Solo top 3 gastos hormiga
      advancedCalculators: false, // Sin acceso a Skip vs Save Challenge
    },
    features: [
      'Transacciones ilimitadas',
      'Hasta 2 presupuestos activos',
      'Hasta 1 meta de ahorro',
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
      reminders: -1, // Recordatorios ilimitados
      budgetAlerts: true, // Alertas de umbral de presupuesto
      textToSpeech: true, // TTS para respuestas de Zenio
      advancedReports: true,
      exportData: true,
      bankIntegration: false,
      antExpenseAnalysis: 'full' as const, // Análisis completo con alertas y recomendaciones
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
      reminders: -1, // Recordatorios ilimitados
      budgetAlerts: true, // Alertas de umbral de presupuesto
      textToSpeech: true, // TTS para respuestas de Zenio
      advancedReports: true,
      exportData: true,
      bankIntegration: true, // Exclusivo PRO: Email Sync
      antExpenseAnalysis: 'full' as const, // Análisis completo con alertas y recomendaciones
      advancedCalculators: true, // Acceso a Skip vs Save Challenge
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
