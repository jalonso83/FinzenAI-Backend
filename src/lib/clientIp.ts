import type { Request } from 'express';

/**
 * IP real del cliente detrás de Railway.
 *
 * `req.ip` NO sirve aquí: `app.set('trust proxy', 1)` confía en UN salto, pero
 * Railway mete dos (edge + interno), así que Express devuelve la IP del edge
 * —Datacamp Limited, Miami— para todo el mundo. Del 12 al 17-sep-2026 eso
 * mandó 90 de 96 registros por Google/Apple a "Estados Unidos" por GeoIP, y de
 * paso hacía que todos los usuarios compartieran la misma IP a ojos de los
 * rate limiters (un `loginLimiter` disparado bloqueaba a todos a la vez).
 *
 * Se lee `X-Forwarded-For` completo y se toma la PRIMERA IP pública de la
 * lista, que es la del cliente. Los proxies van añadiendo la suya al final,
 * así que las últimas son de Railway. Se saltan privadas y loopback por si
 * algún salto interno se cuela al principio.
 */
export function clientIp(req: Request): string | null {
  const raw = req.headers['x-forwarded-for'];
  const header = Array.isArray(raw) ? raw.join(',') : raw;
  if (header) {
    for (const parte of header.split(',')) {
      const ip = limpiar(parte);
      if (ip && esPublica(ip)) return ip;
    }
  }
  const fallback = req.ip ? limpiar(req.ip) : null;
  return fallback || null;
}

/** Quita espacios, el prefijo IPv4-mapped (`::ffff:`) y un puerto si viene. */
function limpiar(ip: string): string {
  let v = ip.trim();
  if (v.startsWith('::ffff:')) v = v.slice(7);
  // "1.2.3.4:5678" (algunos proxies lo mandan así). No tocar IPv6 puro.
  if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(v)) v = v.split(':')[0];
  return v;
}

function esPublica(ip: string): boolean {
  if (ip === '::1' || ip === 'localhost') return false;
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(ip)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return false;
  if (/^(fc|fd|fe80)/i.test(ip)) return false; // IPv6 privada / link-local
  return true;
}
