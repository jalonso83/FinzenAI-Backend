/**
 * Utilidades para manejo de zonas horarias basado en país del usuario
 *
 * Este módulo centraliza la lógica de timezone para que los schedulers
 * puedan enviar notificaciones a la hora local correcta de cada usuario.
 */

// Mapeo de países a zonas horarias IANA
export const COUNTRY_TO_TIMEZONE: Record<string, string> = {
  // Latinoamérica y Caribe
  'República Dominicana': 'America/Santo_Domingo',
  'México': 'America/Mexico_City',
  'Colombia': 'America/Bogota',
  'Panamá': 'America/Panama',
  'Guatemala': 'America/Guatemala',
  'Honduras': 'America/Tegucigalpa',
  'Nicaragua': 'America/Managua',
  'Costa Rica': 'America/Costa_Rica',
  'El Salvador': 'America/El_Salvador',
  'Cuba': 'America/Havana',
  'Puerto Rico': 'America/Puerto_Rico',
  'Argentina': 'America/Argentina/Buenos_Aires',
  'Chile': 'America/Santiago',
  'Uruguay': 'America/Montevideo',
  'Paraguay': 'America/Asuncion',
  'Bolivia': 'America/La_Paz',
  'Perú': 'America/Lima',
  'Ecuador': 'America/Guayaquil',
  'Venezuela': 'America/Caracas',
  'Brasil': 'America/Sao_Paulo',

  // Norteamérica
  'Estados Unidos': 'America/New_York',
  'Canadá': 'America/Toronto',

  // Europa
  'España': 'Europe/Madrid',
  'Francia': 'Europe/Paris',
  'Alemania': 'Europe/Berlin',
  'Italia': 'Europe/Rome',
  'Reino Unido': 'Europe/London',
  'Portugal': 'Europe/Lisbon',
};

// Mapeo de timezones a offsets UTC (valores estándar, no considera DST)
// Nota: Para mayor precisión con DST, usar Intl.DateTimeFormat
const TIMEZONE_OFFSETS: Record<string, number> = {
  'America/Santo_Domingo': -4,
  'America/Caracas': -4,
  'America/Puerto_Rico': -4,
  'America/New_York': -5,
  'America/Bogota': -5,
  'America/Panama': -5,
  'America/Lima': -5,
  'America/Guayaquil': -5,
  'America/Havana': -5,
  'America/Toronto': -5,
  'America/Mexico_City': -6,
  'America/Guatemala': -6,
  'America/Tegucigalpa': -6,
  'America/Managua': -6,
  'America/Costa_Rica': -6,
  'America/El_Salvador': -6,
  'America/La_Paz': -4,
  'America/Santiago': -4,
  'America/Argentina/Buenos_Aires': -3,
  'America/Montevideo': -3,
  'America/Asuncion': -3,
  'America/Sao_Paulo': -3,
  'Europe/London': 0,
  'Europe/Lisbon': 0,
  'Europe/Madrid': 1,
  'Europe/Paris': 1,
  'Europe/Berlin': 1,
  'Europe/Rome': 1,
  'UTC': 0,
};

/**
 * Obtiene la zona horaria IANA basada en el país del usuario
 * @param country - Nombre del país
 * @returns Zona horaria IANA o 'America/Santo_Domingo' por defecto
 */
export function getTimezoneByCountry(country: string | null | undefined): string {
  if (!country) {
    return 'America/Santo_Domingo'; // Default: República Dominicana
  }
  return COUNTRY_TO_TIMEZONE[country] || 'America/Santo_Domingo';
}

/**
 * Obtiene el offset UTC de una zona horaria
 * @param timezone - Zona horaria IANA
 * @returns Offset en horas (ej: -4 para UTC-4)
 */
export function getTimezoneOffset(timezone: string): number {
  return TIMEZONE_OFFSETS[timezone] ?? 0;
}

/**
 * Obtiene la hora local actual para un país dado
 * @param country - Nombre del país
 * @returns Hora actual (0-23) en la zona horaria del país
 */
export function getCurrentLocalHour(country: string | null | undefined): number {
  const timezone = getTimezoneByCountry(country);

  try {
    // Usar Intl.DateTimeFormat para obtener la hora local correctamente
    // Esto maneja automáticamente el horario de verano (DST)
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      hour12: false,
    });

    const hourStr = formatter.format(new Date());
    return parseInt(hourStr, 10);
  } catch (error) {
    // Fallback: usar offset estático
    const offset = getTimezoneOffset(timezone);
    const utcHour = new Date().getUTCHours();
    let localHour = utcHour + offset;

    // Normalizar a rango 0-23
    if (localHour < 0) localHour += 24;
    if (localHour >= 24) localHour -= 24;

    return localHour;
  }
}

/**
 * Obtiene la hora y minutos locales actuales para un país dado
 * @param country - Nombre del país
 * @returns Objeto con hora (0-23) y minutos (0-59)
 */
export function getCurrentLocalTime(country: string | null | undefined): { hour: number; minute: number } {
  const timezone = getTimezoneByCountry(country);

  try {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
    });

    const parts = formatter.formatToParts(now);
    const hour = parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10);
    const minute = parseInt(parts.find(p => p.type === 'minute')?.value || '0', 10);

    return { hour, minute };
  } catch (error) {
    const offset = getTimezoneOffset(timezone);
    const now = new Date();
    const utcHour = now.getUTCHours();
    const utcMinute = now.getUTCMinutes();

    let localHour = utcHour + offset;
    if (localHour < 0) localHour += 24;
    if (localHour >= 24) localHour -= 24;

    return { hour: localHour, minute: utcMinute };
  }
}

/**
 * Verifica si la hora local actual de un país coincide con una hora objetivo
 * @param country - Nombre del país
 * @param targetHour - Hora objetivo (0-23)
 * @param targetMinute - Minuto objetivo (0-59), default 0
 * @param toleranceMinutes - Tolerancia en minutos, default 30
 * @returns true si la hora local está dentro del rango objetivo
 */
export function isTargetLocalTime(
  country: string | null | undefined,
  targetHour: number,
  targetMinute: number = 0,
  toleranceMinutes: number = 30
): boolean {
  const { hour, minute } = getCurrentLocalTime(country);

  // Convertir a minutos totales para comparación más fácil
  const currentTotalMinutes = hour * 60 + minute;
  const targetTotalMinutes = targetHour * 60 + targetMinute;

  // Calcular diferencia considerando el cruce de medianoche
  let diff = Math.abs(currentTotalMinutes - targetTotalMinutes);
  if (diff > 720) { // Más de 12 horas
    diff = 1440 - diff; // Ajustar para cruce de medianoche
  }

  return diff <= toleranceMinutes;
}

/**
 * Verifica si un usuario está en horario silencioso según su zona horaria
 * @param country - País del usuario
 * @param quietHoursStart - Hora de inicio del horario silencioso (0-23)
 * @param quietHoursEnd - Hora de fin del horario silencioso (0-23)
 * @returns true si está en horario silencioso
 */
export function isInQuietHours(
  country: string | null | undefined,
  quietHoursStart: number | null | undefined,
  quietHoursEnd: number | null | undefined
): boolean {
  if (quietHoursStart == null || quietHoursEnd == null) {
    return false;
  }

  const { hour: currentHour } = getCurrentLocalTime(country);

  // Maneja el caso cuando el período cruza la medianoche
  if (quietHoursStart > quietHoursEnd) {
    return currentHour >= quietHoursStart || currentHour < quietHoursEnd;
  }

  return currentHour >= quietHoursStart && currentHour < quietHoursEnd;
}

/**
 * Agrupa una lista de usuarios por su zona horaria
 * @param users - Array de usuarios con campo country
 * @returns Map de timezone -> usuarios
 */
export function groupUsersByTimezone<T extends { country?: string | null }>(
  users: T[]
): Map<string, T[]> {
  const groups = new Map<string, T[]>();

  for (const user of users) {
    const timezone = getTimezoneByCountry(user.country);

    if (!groups.has(timezone)) {
      groups.set(timezone, []);
    }
    groups.get(timezone)!.push(user);
  }

  return groups;
}

/**
 * Obtiene todos los países que actualmente están en una hora específica
 * @param targetHour - Hora objetivo (0-23)
 * @returns Array de países que están en esa hora
 */
export function getCountriesAtLocalHour(targetHour: number): string[] {
  const countries: string[] = [];

  for (const [country] of Object.entries(COUNTRY_TO_TIMEZONE)) {
    const { hour } = getCurrentLocalTime(country);
    if (hour === targetHour) {
      countries.push(country);
    }
  }

  return countries;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * Fronteras de día en la zona horaria del usuario
 *
 * Por qué existe esto: el offset estático de TIMEZONE_OFFSETS no conoce el
 * horario de verano (America/New_York figura como -5 todo el año) y, sobre todo,
 * sumarle horas a un instante NO es lo mismo que situarse en la medianoche local.
 *
 * El bug que motivó estas funciones: la renovación de presupuestos calculaba el
 * inicio del período como `instante + offset`, y acababa guardando ventanas que
 * empezaban a las 19:59 UTC del día 1 (las ~16:00 hora local de RD). Todo lo que
 * la persona gastara el primer día antes de esa hora no caía dentro de ningún
 * presupuesto y desaparecía del cálculo. Medido en producción el 2026-08-10:
 * 38 transacciones de 13 usuarios en ese hueco.
 * ────────────────────────────────────────────────────────────────────────────*/

/**
 * Minutos que hay que sumarle a UTC para obtener la hora local de `timezone` en
 * ese instante. Positivo al este de Greenwich, negativo al oeste (RD = -240).
 * Se mide con Intl, así que respeta el horario de verano de esa fecha concreta.
 */
export function tzOffsetMinutes(timezone: string, at: Date): number {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const partes = dtf.formatToParts(at);
    const v = (tipo: string) => Number(partes.find((p) => p.type === tipo)?.value ?? 0);
    const comoUtc = Date.UTC(v('year'), v('month') - 1, v('day'), v('hour'), v('minute'), v('second'));
    return Math.round((comoUtc - at.getTime()) / 60_000);
  } catch {
    // Zona desconocida: se cae al offset estático, que al menos no revienta.
    return getTimezoneOffset(timezone) * 60;
  }
}

/** Fecha local ('YYYY-MM-DD') que corresponde a ese instante en esa zona. */
export function diaLocalKey(timezone: string, at: Date): string {
  const desplazado = new Date(at.getTime() + tzOffsetMinutes(timezone, at) * 60_000);
  return desplazado.toISOString().slice(0, 10);
}

/** Instante UTC en que EMPIEZA el día local `dayKey` ('YYYY-MM-DD'). */
export function inicioDiaLocalUtc(timezone: string, dayKey: string): Date {
  const medianocheNominal = Date.parse(`${dayKey}T00:00:00Z`);

  // Primera aproximación con el desfase medido a mediodía: con cualquier offset
  // de ±11 h el mediodía UTC sigue cayendo dentro del mismo día local.
  const sonda = new Date(`${dayKey}T12:00:00Z`);
  let candidato = medianocheNominal - tzOffsetMinutes(timezone, sonda) * 60_000;

  // Segunda pasada, midiendo el desfase EN el candidato. Hace falta los días en
  // que cambia el horario de verano: el desfase de la medianoche no es el mismo
  // que el del mediodía. Sin esto, el 1 de noviembre en Nueva York el período
  // arrancaba a la 01:00 local en vez de a las 00:00, y el 8 de marzo se iba al
  // día anterior. Una sola iteración basta: el salto es de una hora y la segunda
  // medición ya cae del lado correcto.
  const offsetReal = tzOffsetMinutes(timezone, new Date(candidato));
  candidato = medianocheNominal - offsetReal * 60_000;

  return new Date(candidato);
}

/** Último milisegundo del día local `dayKey`, como instante UTC. */
export function finDiaLocalUtc(timezone: string, dayKey: string): Date {
  // Se calcula como "inicio del día siguiente menos 1 ms" para que el cambio de
  // hora (DST) no pueda dejar un hueco ni un solape en la frontera.
  const siguiente = sumarDias(dayKey, 1);
  return new Date(inicioDiaLocalUtc(timezone, siguiente).getTime() - 1);
}

/**
 * Aritmética de calendario sobre 'YYYY-MM-DD', sin husos de por medio: se opera
 * en UTC puro para que la zona horaria del servidor no altere el resultado.
 */
export function sumarDias(dayKey: string, dias: number): string {
  const d = new Date(`${dayKey}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

/** Suma meses conservando el día; si el día no existe en el mes destino (31 →
 *  febrero), se queda en el último día de ese mes. */
export function sumarMeses(dayKey: string, meses: number): string {
  const d = new Date(`${dayKey}T00:00:00Z`);
  const dia = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + meses);
  const ultimoDelMes = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(dia, ultimoDelMes));
  return d.toISOString().slice(0, 10);
}

/** Último día del mes al que pertenece `dayKey`, como 'YYYY-MM-DD'. */
export function finDeMes(dayKey: string): string {
  const d = new Date(`${dayKey}T00:00:00Z`);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
}
