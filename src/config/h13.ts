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

// ─── Corridas (ediciones) del experimento ────────────────────────────────────
//
// El H13 no es UN experimento eterno: es una serie de CORRIDAS. Se corre una con
// ventana de 7 días, cierra, se mide. Después se corre otra con 15, que es una
// cohorte distinta con su propio resultado — no una continuación de la primera.
//
// Cada corrida es su propia `experimentKey` ('h13-1', 'h13-2', ...), que es
// justo para lo que se diseñaron experiment_participants y experiment_events
// ("keyed por experimentKey"). Con eso cada corrida tiene, sin código extra:
// su cohorte (por el @@unique(userId, experimentKey)), sus eventos, su fecha de
// inicio y su análisis.
//
// Un usuario no puede caer en dos corridas: el enrolamiento exige que sea su
// PRIMERA transacción, así que una corrida nueva solo recluta usuarios nuevos —
// que es lo correcto para un experimento de "primera semana". La excepción es la
// whitelist de dogfood, que sí puede repetir; ahí se toma la corrida más
// reciente del usuario.
//
// Env vars:
//   H13_RUN          = 'h13-2'                               (default: 'h13-1')
//   H13_WINDOW_DAYS  = '7' | '14' | '21' | '30' | '45' ...   (default: 7)
//   H13_TARGET_RATIO = '0.4286'                              (default: 3/7)
//
// Para arrancar una corrida nueva: cambiar H13_RUN a una clave que no se haya
// usado y fijar sus parámetros. Sin deploy.

/** Prefijo común a todas las corridas. Sirve para buscar la participación de un
 *  usuario sin saber en qué corrida cayó. */
export const H13_KEY_PREFIX = 'h13';

const FALLBACK_RUN = 'h13-1';

/**
 * Clave de la corrida ACTIVA — la que recluta participantes nuevos. Las corridas
 * anteriores siguen vivas en la base y sus participantes en curso terminan su
 * reto con normalidad; esto solo decide dónde entran los que llegan ahora.
 */
export function h13Run(): string {
  const raw = (process.env.H13_RUN || '').trim();
  // Se exige el prefijo: las búsquedas por usuario van por `startsWith('h13')`,
  // así que una clave fuera del prefijo quedaría invisible para el propio flujo.
  if (!raw || !raw.startsWith(H13_KEY_PREFIX)) return FALLBACK_RUN;
  return raw;
}

// ─── Duración del reto ───────────────────────────────────────────────────────
//
// Los parámetros son de la CORRIDA, y se congelan por participante al enrolar
// (ver h13Params en h13Service) para que el análisis de una corrida vieja siga
// leyéndose bien aunque hoy corra otra con otros números.
//
// Solo afectan a quien se enrole DE AHORA EN ADELANTE: al entrar, cada
// participante se lleva su ventana y su objetivo CONGELADOS en `data` (ver
// h13Params en h13Service). Cambiar estas variables NO le mueve la meta a nadie
// que ya esté corriendo — justamente para que el análisis no mezcle cohortes
// medidas con reglas distintas.

const FALLBACK_WINDOW_DAYS = 7;
const MAX_WINDOW_DAYS = 365;

/** Ventana configurada para los reclutas NUEVOS. Ante un valor inválido, 7. */
export function h13WindowDays(): number {
  const raw = Number(process.env.H13_WINDOW_DAYS);
  if (!Number.isInteger(raw) || raw < 1 || raw > MAX_WINDOW_DAYS) return FALLBACK_WINDOW_DAYS;
  return raw;
}

/**
 * Objetivo PROPORCIONAL a la ventana. Hoy el reto pide 3 días de 7 (43% de los
 * días); esa proporción se mantiene al alargar la ventana, así el reto conserva
 * su naturaleza y solo cambia de duración.
 *
 *   7 → 3    14 → 6    15 → 6    21 → 9    30 → 13    45 → 19
 *
 * Con ventana de 7 da exactamente 3, o sea que reproduce el comportamiento
 * histórico clavado.
 *
 * OJO al interpretar resultados: mantener la proporción NO mantiene la
 * dificultad. Sostener el 43% de los días durante 45 es bastante más duro que
 * durante 7, así que una ventana larga tenderá a completar menos aunque el ratio
 * sea el mismo. Si se comparan ventanas entre sí, eso hay que tenerlo en cuenta.
 */
export function h13TargetDaysFor(windowDays: number): number {
  const raw = Number(process.env.H13_TARGET_RATIO);
  const ratio = raw > 0 && raw <= 1 ? raw : 3 / 7;
  const target = Math.round(windowDays * ratio);
  // Nunca 0 (reto imposible de fallar) ni más que la ventana (imposible de ganar).
  return Math.min(Math.max(target, 1), windowDays);
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
