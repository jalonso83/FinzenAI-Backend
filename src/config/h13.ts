import crypto from 'crypto';

/**
 * H13 · Reto de la Primera Semana — flag (kill switch) + asignación de brazo.
 *
 * Todo el experimento vive detrás de H13_ENABLED. Si está apagado, no se asigna
 * brazo ni se dispara ningún flujo — reversible al instante sin deploy de código.
 *
 * Env vars:
 *   H13_ENABLED   = 'true' | 'false'          (default: 'false')
 *   H13_WHITELIST = 'userId1,userId2,...'      (default: '') — fuerza incluir en el
 *                   experimento aunque el flag global esté off (dogfood / QA).
 */
export function isH13Enabled(userId?: string): boolean {
  const whitelist = (process.env.H13_WHITELIST || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (userId && whitelist.includes(userId)) return true;

  return process.env.H13_ENABLED === 'true';
}

export type H13Arm = 'reto' | 'control';

/**
 * Asignación estable 50/50 al brazo del experimento. Hash sha256 con salt propio
 * ('h13_reto_v1') — independiente de cualquier bucket previo (H10, etc.), mismo
 * patrón que `userBucket` en controllers/config.ts. El mismo userId siempre cae en
 * el mismo brazo, así que es idempotente y reproducible.
 */
export function assignArm(userId: string): H13Arm {
  const hash = crypto.createHash('sha256').update(`h13_reto_v1:${userId}`).digest();
  return hash.readUInt32BE(0) % 2 === 0 ? 'control' : 'reto';
}
