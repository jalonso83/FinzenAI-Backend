/**
 * Operating Costs Configuration
 * Costos operativos fijos mensuales (anuales prorrateados a mensual).
 *
 * Cuando renueves Apple Developer, GoDaddy, etc., actualiza aquí.
 * Cuando contrates/canceles una herramienta, ajusta aquí y haz deploy.
 *
 * Para fees variables (Stripe, RevenueCat, OpenAI) se calculan en runtime.
 */

export interface FixedCost {
  name: string;
  category: 'infrastructure' | 'communication' | 'platform' | 'tools' | 'marketing';
  monthlyAmount: number; // USD, ya prorrateado si era anual
  notes?: string;
}

export const FIXED_OPERATING_COSTS: FixedCost[] = [
  // ── Infraestructura ──────────────────────────────────────────────
  { name: 'Railway',  category: 'infrastructure', monthlyAmount: 20.00 },
  { name: 'Firebase', category: 'infrastructure', monthlyAmount: 0.00, notes: 'tier gratis' },
  { name: 'GoDaddy (dominio + correo)', category: 'infrastructure', monthlyAmount: 97 / 12, notes: '$97/año prorrateado' },

  // ── Comunicación ─────────────────────────────────────────────────
  { name: 'Resend', category: 'communication', monthlyAmount: 20.00 },

  // ── Plataformas mobile ───────────────────────────────────────────
  { name: 'Apple Developer', category: 'platform', monthlyAmount: 99 / 12, notes: '$99/año prorrateado' },
  { name: 'EAS (Expo Build)', category: 'platform', monthlyAmount: 20.00 },

  // ── Herramientas equipo ──────────────────────────────────────────
  { name: 'Cursor', category: 'tools', monthlyAmount: 20.00 },
  { name: 'Claude (dev)', category: 'tools', monthlyAmount: 200.00 },

  // ── Marketing ────────────────────────────────────────────────────
  { name: 'Marketing', category: 'marketing', monthlyAmount: 100.00 },
];

export const TOTAL_FIXED_MONTHLY = FIXED_OPERATING_COSTS.reduce(
  (sum, c) => sum + c.monthlyAmount,
  0
);

// ── Tasas de fees variables ──────────────────────────────────────────
export const PAYMENT_FEES = {
  stripe: {
    percentage: 0.029,    // 2.9%
    fixed: 0.30,          // $0.30 por transacción
  },
  revenueCat: {
    apple: 0.30,          // 30% Apple platform fee
    revenueCat: 0.01,     // 1% RevenueCat sobre gross
    // Total efectivo sobre gross: 31%
  },
};
