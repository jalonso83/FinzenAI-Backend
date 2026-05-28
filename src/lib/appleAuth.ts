import { createRemoteJWKSet, jwtVerify } from 'jose';
import { ENV } from '../config/env';
import { logger } from '../utils/logger';

const APPLE_ISSUER = 'https://appleid.apple.com';
const APPLE_JWKS_URL = new URL('https://appleid.apple.com/auth/keys');

// jose cachea las llaves automáticamente (TTL ~10 min por defecto).
const APPLE_JWKS = createRemoteJWKSet(APPLE_JWKS_URL);

export interface AppleVerifiedToken {
  sub: string;
  email: string | null;
  emailVerified: boolean;
  isPrivateRelay: boolean;
}

/**
 * Verifica el identityToken JWT que envía Apple Sign-In.
 *
 * Pasos:
 *  1. Verifica la firma RS256 contra las llaves públicas de Apple (JWKS).
 *  2. Valida iss === https://appleid.apple.com.
 *  3. Valida aud === bundle ID de la app iOS (APPLE_BUNDLE_ID).
 *  4. Valida que no esté expirado (exp > now), jose lo hace automáticamente.
 *
 * Si todo OK retorna sub (ID estable del usuario en Apple) + email + flags.
 * Si falla cualquier validación lanza Error.
 *
 * Notas sobre el email:
 *  - Apple solo incluye email en el PRIMER login. En logins subsecuentes el
 *    campo puede no venir. Por eso el flujo de linkeo busca primero por sub.
 *  - Si el usuario eligió "Hide my email", email termina en @privaterelay.appleid.com.
 *    Es un email válido — Apple reenvía los correos al email real del usuario.
 */
export async function verifyAppleIdentityToken(identityToken: string): Promise<AppleVerifiedToken> {
  const { payload } = await jwtVerify(identityToken, APPLE_JWKS, {
    issuer: APPLE_ISSUER,
    audience: ENV.APPLE_BUNDLE_ID,
  });

  const sub = typeof payload.sub === 'string' ? payload.sub : null;
  if (!sub) {
    throw new Error('Apple identityToken sin claim sub');
  }

  const email = typeof payload.email === 'string' ? payload.email : null;
  // Apple manda email_verified como string "true" / "false" en algunos casos.
  const rawVerified = payload.email_verified;
  const emailVerified = rawVerified === true || rawVerified === 'true';
  const isPrivateRelay = !!email && email.endsWith('@privaterelay.appleid.com');

  if (!email) {
    logger.warn('[AppleAuth] identityToken sin email — probable login subsecuente. Linkeo por sub.');
  }

  return { sub, email, emailVerified, isPrivateRelay };
}
