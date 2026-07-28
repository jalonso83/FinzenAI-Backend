import { RecurrenceFrequency } from '@prisma/client';
import { logger } from '../utils/logger';

/**
 * Configuración de Gastos/Ingresos Recurrentes - FinZen AI
 *
 * =====================================================
 * PARA CAMBIAR EL COMPORTAMIENTO:
 * =====================================================
 *
 * Opción 1: Variables de entorno (Railway / .env) — no requiere deploy de código
 * Opción 2: Editar los defaults de este archivo + deploy
 * Opción 3: Apagar el motor: RECURRING_ENABLED=false
 *           (las reglas quedan guardadas, el cron deja de generar nada)
 *
 * =====================================================
 */

/**
 * Lee un entero de env respetando el 0.
 *
 * `Number(process.env.X) || default` — el patrón corto — trata el 0 como
 * ausente: poner RECURRING_RUN_LOCAL_HOUR=0 (medianoche) daría el default 6.
 * También descarta valores no numéricos en vez de propagar NaN.
 */
function intFromEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return defaultValue;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    logger.error(`[RecurringConfig] ${name}="${raw}" no es un número. Usando el default ${defaultValue}.`);
    return defaultValue;
  }
  return Math.trunc(parsed);
}

function boolFromEnv(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return defaultValue;
  return raw.trim().toLowerCase() !== 'false';
}

function strFromEnv(name: string, defaultValue: string): string {
  const raw = process.env[name];
  return raw && raw.trim() !== '' ? raw.trim() : defaultValue;
}

export interface RecurringConfigType {
  ENABLED: boolean;
  NOTIFY_ENABLED: boolean;
  RUN_LOCAL_HOUR: number;
  MAX_CATCHUP_PER_RUN: number;
  CRON_SCHEDULE: string;
  SUFFIX_EXPENSE: string;
  SUFFIX_INCOME: string;
  SUFFIX_SEPARATOR: string;
}

export const RECURRING_CONFIG: RecurringConfigType = {
  /**
   * Kill switch del motor. En false el scheduler no arranca y no se genera
   * ninguna transacción automática. Las reglas ya creadas no se tocan.
   * Default: true
   */
  ENABLED: boolFromEnv('RECURRING_ENABLED', true),

  /**
   * Enviar push cuando se registran movimientos automáticos.
   * Default: true (sin aviso, el usuario ve plata moverse sin saber por qué)
   */
  NOTIFY_ENABLED: boolFromEnv('RECURRING_NOTIFY_ENABLED', true),

  /**
   * Hora LOCAL del usuario a la que se procesan sus recurrentes (0-23).
   * Por eso el cron corre cada hora: cada quien recibe su movimiento a una
   * hora razonable de SU huso, no a las 2 AM del server.
   * Default: 6
   */
  RUN_LOCAL_HOUR: intFromEnv('RECURRING_RUN_LOCAL_HOUR', 6),

  /**
   * Tope de ocurrencias que una misma regla genera en una sola corrida.
   * Protege el caso "el server estuvo caído": en vez de inyectar 40
   * transacciones de golpe, genera este máximo y el resto queda para mañana.
   * Default: 12
   */
  MAX_CATCHUP_PER_RUN: intFromEnv('RECURRING_MAX_CATCHUP_PER_RUN', 12),

  /**
   * Expresión cron del scheduler. Cada hora por defecto — el filtro fino es
   * RUN_LOCAL_HOUR, este solo define cada cuánto se despierta a mirar.
   * Default: '0 * * * *'
   */
  CRON_SCHEDULE: strFromEnv('RECURRING_CRON_SCHEDULE', '0 * * * *'),

  /**
   * Sufijos que identifican al movimiento como automático en su descripción.
   * Default: 'Pago automático' / 'Ingreso automático'
   */
  SUFFIX_EXPENSE: strFromEnv('RECURRING_SUFFIX_EXPENSE', 'Pago automático'),
  SUFFIX_INCOME: strFromEnv('RECURRING_SUFFIX_INCOME', 'Ingreso automático'),
  SUFFIX_SEPARATOR: strFromEnv('RECURRING_SUFFIX_SEPARATOR', ' · '),
};

/**
 * Frecuencias válidas, derivadas del enum de Prisma.
 *
 * Se deriva en vez de escribirse a mano para que agregar una frecuencia al
 * schema no deje la validación del endpoint desactualizada en silencio.
 */
export const VALID_FREQUENCIES = Object.values(RecurrenceFrequency) as RecurrenceFrequency[];

export function isValidFrequency(value: unknown): value is RecurrenceFrequency {
  return typeof value === 'string' && (VALID_FREQUENCIES as string[]).includes(value);
}

/**
 * Valida la configuración al arrancar. Un valor fuera de rango no debe
 * descubrirse en producción a las 6 AM cuando el cron no dispara.
 */
export function validateRecurringConfig(): void {
  const errors: string[] = [];

  if (!Number.isInteger(RECURRING_CONFIG.RUN_LOCAL_HOUR) ||
      RECURRING_CONFIG.RUN_LOCAL_HOUR < 0 ||
      RECURRING_CONFIG.RUN_LOCAL_HOUR > 23) {
    errors.push(`RECURRING_RUN_LOCAL_HOUR debe estar entre 0 y 23 (actual: ${RECURRING_CONFIG.RUN_LOCAL_HOUR})`);
  }

  if (RECURRING_CONFIG.MAX_CATCHUP_PER_RUN < 1) {
    errors.push(`RECURRING_MAX_CATCHUP_PER_RUN debe ser al menos 1 (actual: ${RECURRING_CONFIG.MAX_CATCHUP_PER_RUN})`);
  }

  if (errors.length > 0) {
    errors.forEach(e => logger.error(`[RecurringConfig] ❌ ${e}`));
    throw new Error(`Configuración de recurrentes inválida: ${errors.join('; ')}`);
  }

  logger.log(
    `[RecurringConfig] ✅ Recurrentes ${RECURRING_CONFIG.ENABLED ? 'habilitados' : 'DESHABILITADOS'} · ` +
    `hora local ${RECURRING_CONFIG.RUN_LOCAL_HOUR}:00 · catch-up máx ${RECURRING_CONFIG.MAX_CATCHUP_PER_RUN}`
  );
}
