import Stripe from 'stripe';

// Inicializar Stripe
export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
  apiVersion: '2025-10-29.clover',
  typescript: true,
});

export const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';

// Definición de planes y límites
export const PLANS = {
  FREE: {
    name: 'Gratis',
    price: 0,
    stripePriceId: null,
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
    name: 'Premium',
    price: 9.99,
    stripePriceId: process.env.STRIPE_PREMIUM_PRICE_ID || '',
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
    price: 19.99,
    stripePriceId: process.env.STRIPE_PRO_PRICE_ID || '',
    limits: {
      budgets: -1,
      goals: -1,
      zenioQueries: -1,
      advancedReports: true,
      exportData: true,
      bankIntegration: true,
    },
    features: [
      'Todo lo de Premium',
      'Detección automática de gastos desde tu correo',
      'Proyecciones de inversión',
      'Acceso anticipado a nuevas features',
    ],
  },
} as const;

export type PlanType = keyof typeof PLANS;
