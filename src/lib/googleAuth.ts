import { OAuth2Client } from 'google-auth-library';
import { ENV } from '../config/env';

const googleClient = new OAuth2Client();

export interface GoogleVerifiedToken {
  sub: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  givenName: string | null;
  familyName: string | null;
  picture: string | null;
}

/**
 * Verifica el idToken JWT que envía Google Sign-In.
 *
 * Internamente google-auth-library:
 *  1. Descarga las llaves públicas de Google y las cachea.
 *  2. Verifica la firma RS256.
 *  3. Valida iss in [accounts.google.com, https://accounts.google.com].
 *  4. Valida aud === GOOGLE_WEB_CLIENT_ID.
 *  5. Valida exp > now.
 *
 * El audience tiene que ser el Web Client ID (no el iOS ni el Android client),
 * porque ambos SDKs nativos piden ese Web Client ID como serverClientId y
 * Google emite el idToken con aud = Web Client ID para que el backend lo
 * valide del mismo modo desde cualquier plataforma.
 */
export async function verifyGoogleIdToken(idToken: string): Promise<GoogleVerifiedToken> {
  const ticket = await googleClient.verifyIdToken({
    idToken,
    audience: ENV.GOOGLE_WEB_CLIENT_ID,
  });

  const payload = ticket.getPayload();
  if (!payload || !payload.sub) {
    throw new Error('Google idToken sin payload o sin sub');
  }

  return {
    sub: payload.sub,
    email: payload.email ?? null,
    emailVerified: !!payload.email_verified,
    name: payload.name ?? null,
    givenName: payload.given_name ?? null,
    familyName: payload.family_name ?? null,
    picture: payload.picture ?? null,
  };
}
