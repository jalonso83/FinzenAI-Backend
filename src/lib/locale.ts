import { logger } from '../utils/logger';

/**
 * Mapeo de ISO 3166-1 alpha-2 (country code) a nombre en español
 * usado en la columna `country` de users. Los nombres coinciden con los
 * que el RegisterScreen guarda (Latam + US + ES).
 */
export const COUNTRY_CODE_TO_NAME: Record<string, string> = {
  AR: 'Argentina',
  BO: 'Bolivia',
  BR: 'Brasil',
  CL: 'Chile',
  CO: 'Colombia',
  CR: 'Costa Rica',
  CU: 'Cuba',
  DO: 'República Dominicana',
  EC: 'Ecuador',
  SV: 'El Salvador',
  GT: 'Guatemala',
  HN: 'Honduras',
  MX: 'México',
  NI: 'Nicaragua',
  PA: 'Panamá',
  PY: 'Paraguay',
  PE: 'Perú',
  PR: 'Puerto Rico',
  UY: 'Uruguay',
  VE: 'Venezuela',
  US: 'Estados Unidos',
  ES: 'España',
};

/**
 * Mapeo de country code a moneda local. Países que usan USD como moneda
 * oficial (EC, SV, PA, PR) se marcan como USD. PA tiene PAB de jure pero
 * USD circula a la par — usamos USD por practicidad para users mobile.
 */
export const COUNTRY_TO_CURRENCY: Record<string, string> = {
  AR: 'ARS',
  BO: 'BOB',
  BR: 'BRL',
  CL: 'CLP',
  CO: 'COP',
  CR: 'CRC',
  CU: 'CUP',
  DO: 'DOP',
  EC: 'USD',
  SV: 'USD',
  GT: 'GTQ',
  HN: 'HNL',
  MX: 'MXN',
  NI: 'NIO',
  PA: 'USD',
  PY: 'PYG',
  PE: 'PEN',
  PR: 'USD',
  UY: 'UYU',
  VE: 'VES',
  US: 'USD',
  ES: 'EUR',
};

export interface InferredLocale {
  country: string;
  currency: string;
}

/**
 * Devuelve { country, currency } para un country code ISO (DO, US, MX, ...).
 * Retorna null si el código no está en el mapeo soportado (apps fuera de Latam).
 */
export function inferLocaleFromCountryCode(code: string | null | undefined): InferredLocale | null {
  if (!code) return null;
  const normalized = code.trim().toUpperCase();
  const country = COUNTRY_CODE_TO_NAME[normalized];
  const currency = COUNTRY_TO_CURRENCY[normalized];
  if (!country || !currency) return null;
  return { country, currency };
}

/**
 * Resuelve country code via GeoIP usando ipwho.is (gratis, HTTPS, sin API key).
 * Timeout corto (2s) — si falla o se pasa, retorna null y el caller usa default.
 *
 * Limitaciones conocidas:
 *  - VPN users devuelven país de exit node
 *  - IPs privadas / localhost devuelven null
 *  - Rate limit no documentado, pero observado ~10k req/día sin problema
 */
export async function inferCountryCodeFromIp(ip: string | null | undefined): Promise<string | null> {
  if (!ip) return null;
  // Filtrar IPs privadas y loopback — GeoIP no las puede resolver.
  if (ip === '::1' || ip.startsWith('127.') || ip.startsWith('10.') || ip.startsWith('192.168.')) {
    return null;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 2000);

  try {
    const response = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}`, {
      signal: controller.signal,
    });
    if (!response.ok) return null;

    const json = (await response.json()) as { success?: boolean; country_code?: string };
    if (json?.success === false || !json?.country_code) return null;

    return String(json.country_code).toUpperCase();
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      logger.warn(`[Locale] GeoIP timeout para ip=${ip}`);
    } else {
      logger.warn(`[Locale] GeoIP error para ip=${ip}:`, err?.message ?? err);
    }
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Default global cuando ninguna señal detecta el país. USD es la opción más
 * compatible internacionalmente — la app funciona desde el primer minuto y
 * el user puede cambiar país/moneda desde Profile si está mal.
 */
const SSO_LOCALE_DEFAULT: InferredLocale = {
  country: 'Estados Unidos',
  currency: 'USD',
};

/**
 * Resuelve country + currency para un user SSO nuevo combinando señales:
 *  1. deviceCountry pasado por la app (Localization.region) — más confiable
 *  2. Primera región del deviceLocale ("es-DO" → DO) como fallback secundario
 *  3. GeoIP del request — fallback si la app no mandó nada
 *  4. Default a USD/Estados Unidos si nada match — app funcional desde minuto cero.
 */
export async function resolveSSOLocale(opts: {
  deviceCountry: string | null | undefined;
  deviceLocale: string | null | undefined;
  ipAddress: string | null | undefined;
}): Promise<InferredLocale> {
  // 1. Device country (más confiable)
  const fromDevice = inferLocaleFromCountryCode(opts.deviceCountry);
  if (fromDevice) return fromDevice;

  // 2. Locale tipo "es-DO" → extraer "DO"
  if (opts.deviceLocale && opts.deviceLocale.includes('-')) {
    const region = opts.deviceLocale.split('-')[1];
    const fromLocale = inferLocaleFromCountryCode(region);
    if (fromLocale) return fromLocale;
  }

  // 3. GeoIP fallback
  const ipCountry = await inferCountryCodeFromIp(opts.ipAddress);
  const fromIp = inferLocaleFromCountryCode(ipCountry);
  if (fromIp) return fromIp;

  // 4. Default global
  return SSO_LOCALE_DEFAULT;
}
