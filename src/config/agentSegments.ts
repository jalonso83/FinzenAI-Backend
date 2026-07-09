import { AudienceFilters, AudienceSegment } from '../services/broadcastService';

// ─────────────────────────────────────────────────────────────────────────
// Catálogo de segmentos de la Agent API (capa semántica).
//
// Este archivo ES el catálogo: cada entrada define un segmento curado que el
// agente de crecimiento puede consultar (solo conteos, nunca PII) y usar como
// audiencia de un borrador de campaña. Para agregar un segmento nuevo:
//  1. Si es combinable con los filtros existentes → basta una entrada aquí.
//  2. Si necesita lógica nueva → agregar el AudienceSegment en broadcastService
//     (audienceBody) y luego la entrada aquí. El review humano de este archivo
//     es el guardarraíl: el agente nunca ejecuta SQL libre.
//
// Todos los segmentos aceptan los parámetros estándar (combinables):
//  - plans: subconjunto de FREE|PREMIUM|PRO (CSV). Default: todos.
//  - platforms: subconjunto de IOS|ANDROID (CSV). Default: ambas.
//  - country: nombre de país exacto. Default: todos.
// ─────────────────────────────────────────────────────────────────────────

const VALID_PLANS = ['FREE', 'PREMIUM', 'PRO'];
const VALID_PLATFORMS = ['IOS', 'ANDROID'];

export interface AgentSegmentParamSpec {
  name: string;
  type: 'int' | 'string' | 'csv';
  required: boolean;
  default?: string | number;
  description: string;
}

export interface AgentSegmentDef {
  slug: string;
  name: string;
  description: string;
  params: AgentSegmentParamSpec[];
  /** Traduce los params validados a los filtros del motor de audiencias. */
  buildFilters(params: Record<string, string | undefined>): AudienceFilters;
}

// Parámetros estándar disponibles en todos los segmentos.
const STANDARD_PARAMS: AgentSegmentParamSpec[] = [
  { name: 'plans', type: 'csv', required: false, default: 'FREE,PREMIUM,PRO', description: 'Planes a incluir (CSV de FREE|PREMIUM|PRO)' },
  { name: 'platforms', type: 'csv', required: false, default: 'IOS,ANDROID', description: 'Plataformas del dispositivo (CSV de IOS|ANDROID)' },
  { name: 'country', type: 'string', required: false, description: 'País exacto; omitir para todos' },
];

function parseCsvParam(raw: string | undefined, valid: string[], fallback: string[]): string[] {
  if (!raw) return fallback;
  const values = raw.split(',').map((v) => v.trim().toUpperCase()).filter(Boolean);
  const filtered = values.filter((v) => valid.includes(v));
  return filtered.length > 0 ? filtered : fallback;
}

function parseIntParam(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/** Filtros base: params estándar + el segmento propio. */
function baseFilters(segment: AudienceSegment, params: Record<string, string | undefined>): AudienceFilters {
  return {
    plans: parseCsvParam(params.plans, VALID_PLANS, VALID_PLANS),
    platforms: parseCsvParam(params.platforms, VALID_PLATFORMS, VALID_PLATFORMS),
    country: params.country || undefined,
    segments: [segment],
    // El tipo define el opt-out aplicado al conteo/envío. Las campañas del
    // agente son siempre MARKETING (respeta marketingEnabled).
    type: 'MARKETING',
  };
}

export const AGENT_SEGMENTS: AgentSegmentDef[] = [
  {
    slug: 'never_activated',
    name: 'Nunca activados',
    description: 'Usuarios registrados que nunca crearon una transacción (0 transacciones de por vida).',
    params: [...STANDARD_PARAMS],
    buildFilters: (p) => baseFilters('never_activated', p),
  },
  {
    slug: 'dormant',
    name: 'Dormidos',
    description: 'Usuarios que alguna vez usaron la app (≥1 transacción) pero llevan N días sin actividad.',
    params: [
      { name: 'days', type: 'int', required: false, default: 14, description: 'Días sin actividad para considerarse dormido (1-365)' },
      ...STANDARD_PARAMS,
    ],
    buildFilters: (p) => ({
      ...baseFilters('dormant', p),
      dormantDays: parseIntParam(p.days, 14, 1, 365),
    }),
  },
  {
    slug: 'active',
    name: 'Activos',
    description: 'Usuarios con ≥1 transacción y actividad dentro de los últimos N días.',
    params: [
      { name: 'days', type: 'int', required: false, default: 14, description: 'Ventana de actividad reciente en días (1-365)' },
      ...STANDARD_PARAMS,
    ],
    buildFilters: (p) => ({
      ...baseFilters('active', p),
      dormantDays: parseIntParam(p.days, 14, 1, 365),
    }),
  },
  {
    slug: 'budget_exceeded',
    name: 'Presupuesto excedido',
    description: 'Usuarios con al menos un presupuesto vigente cuyo gasto (spent) superó el monto (amount).',
    params: [...STANDARD_PARAMS],
    buildFilters: (p) => baseFilters('budget_exceeded', p),
  },
  {
    slug: 'trial_ending',
    name: 'Trial por vencer',
    description: 'Usuarios con suscripción en trial (TRIALING) que vence dentro de los próximos N días.',
    params: [
      { name: 'days', type: 'int', required: false, default: 3, description: 'Ventana hasta el vencimiento del trial en días (1-30)' },
      ...STANDARD_PARAMS,
    ],
    buildFilters: (p) => ({
      ...baseFilters('trial_ending', p),
      trialEndingDays: parseIntParam(p.days, 3, 1, 30),
    }),
  },
];

export function getAgentSegment(slug: string): AgentSegmentDef | undefined {
  return AGENT_SEGMENTS.find((s) => s.slug === slug);
}
