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
 *                   También exime del requisito de "primera transacción", para
 *                   poder probar con cuentas que ya tienen historial.
 */
function h13Whitelist(): string[] {
  return (process.env.H13_WHITELIST || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * ¿Es un usuario de dogfood/QA? Se usa para relajar condiciones de enrolamiento
 * que solo tienen sentido con usuarios reales (ver onValidTransaction: exige que
 * sea la PRIMERA transacción, cosa que una cuenta de prueba ya usada nunca
 * cumple).
 *
 * OJO al construir el análisis de H13: estos usuarios NO son asignación
 * aleatoria y hay que excluirlos de la cohorte, igual que hace H10 en
 * controllers/experiments.ts.
 */
export function isH13Whitelisted(userId?: string): boolean {
  if (!userId) return false;
  return h13Whitelist().includes(userId);
}

/**
 * ¿Está prendido el flag GLOBAL? Distinto de isH13Enabled, que también da true
 * por whitelist. Se usa para estampar la fecha de inicio del experimento: si
 * contara la whitelist, el dogfood de hoy marcaría el arranque semanas antes
 * del lanzamiento real y la cohorte quedaría mal anclada.
 */
export function isH13FlagOn(): boolean {
  return process.env.H13_ENABLED === 'true';
}

export function isH13Enabled(userId?: string): boolean {
  if (isH13Whitelisted(userId)) return true;

  return isH13FlagOn();
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
