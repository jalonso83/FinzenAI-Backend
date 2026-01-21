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
