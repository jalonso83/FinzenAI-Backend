import crypto from 'crypto';

/**
 * Hash determinístico de userId → bucket 0-99, namespaced por feature.
 *
 * El mismo usuario siempre cae en el mismo bucket para una feature dada, y la
 * asignación es INDEPENDIENTE entre features (el prefijo namespacea). Reconstruible
 * en SQL/post-hoc, así que sirve para experimentos y holdouts sin guardar el grupo.
 *
 * Misma fórmula que el bucket de feature flags de onboarding (config.ts): para
 * holdouts de campañas usamos `featureName = broadcastId`, así cada campaña tiene
 * su propio split sin correlacionar con otras.
 */
export function userBucket(userId: string, featureName: string): number {
  const hash = crypto
    .createHash('sha256')
    .update(`${featureName}:${userId}`)
    .digest();
  return hash.readUInt32BE(0) % 100;
}
