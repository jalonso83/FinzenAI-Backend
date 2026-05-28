import { Request, Response } from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import type { User, AuthProvider } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { ENV } from '../config/env';
import { logger } from '../utils/logger';
import { verifyAppleIdentityToken } from '../lib/appleAuth';
import { verifyGoogleIdToken } from '../lib/googleAuth';
import { ingestAttributionEvent } from '../services/attributionEventService';
import { ReferralService } from '../services/referralService';
import { REFERRAL_CONFIG } from '../config/referralConfig';

// ============================================
// HELPERS
// ============================================

function generateAuthJwt(user: Pick<User, 'id' | 'email'>): string {
  return jwt.sign(
    { userId: user.id, email: user.email },
    ENV.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '7d' }
  );
}

function buildLoginResponse(user: User, isNewUser: boolean, linked: boolean) {
  return {
    message: 'SSO login successful',
    token: generateAuthJwt(user),
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      verified: user.verified,
      onboardingCompleted: user.onboardingCompleted,
    },
    isNewUser,
    linked,
  };
}

/**
 * Dispara evento CompleteRegistration a la Conversion API de Meta/TikTok.
 * Mismo patrón que register en auth.ts — fire-and-forget.
 */
function fireCompleteRegistration(user: User, req: Request): void {
  const completeRegEventId = crypto.createHash('sha256')
    .update(`register:${user.id}`).digest('hex');
  const deterministicId = [
    completeRegEventId.slice(0, 8),
    completeRegEventId.slice(8, 12),
    '4' + completeRegEventId.slice(13, 16),
    ((parseInt(completeRegEventId[16], 16) & 0x3) | 0x8).toString(16) + completeRegEventId.slice(17, 20),
    completeRegEventId.slice(20, 32),
  ].join('-');

  void ingestAttributionEvent({
    eventName: 'CompleteRegistration',
    eventId: deterministicId,
    userId: user.id,
    email: user.email,
    phone: null,
    ipAddress: req.ip ?? null,
    userAgent: req.get('user-agent') ?? null,
    actionSource: 'app',
    customData: {
      country: user.country || null,
      authProvider: user.authProvider,
    },
  }).catch((err) => {
    logger.warn('[SSO] No se pudo disparar CompleteRegistration:', err);
  });
}

/**
 * Aplica el código de referido si vino en el request — mismo patrón que register.
 */
async function applyReferralIfPresent(userId: string, email: string, referralCode: string | undefined): Promise<void> {
  if (!referralCode || !REFERRAL_CONFIG.ENABLED) return;
  try {
    const fraudCheck = await ReferralService.checkFraudIndicators('', email);
    if (fraudCheck.suspicious) {
      logger.warn(`[SSO] Referido sospechoso para ${email}: ${fraudCheck.reasons.join(', ')}`);
      return;
    }
    const result = await ReferralService.applyReferralCode(userId, email, referralCode);
    if (result.success) {
      logger.log(`[SSO] Referral aplicado ${referralCode} para ${userId}`);
    }
  } catch (err) {
    logger.error('[SSO] Error aplicando referral:', err);
  }
}

interface SSOResolveInput {
  provider: AuthProvider;
  sub: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  lastName: string | null;
}

interface SSOResolveResult {
  user: User;
  isNewUser: boolean;
  linked: boolean;
}

/**
 * Resuelve un sign-in SSO:
 *  1. Busca user por sub del provider → si existe, login directo.
 *  2. Si no, y email viene verificado del provider, busca user por email →
 *     si existe, LINKEA (guarda el sub en ese user) y devuelve.
 *  3. Si no hay match por sub ni por email verificado, crea un user nuevo.
 *
 * Lanza Error si no se puede resolver (ej: Apple subsecuente sin email y sub no existe).
 */
async function resolveSSOUser(input: SSOResolveInput): Promise<SSOResolveResult> {
  const { provider, sub, email, emailVerified, name, lastName } = input;
  const subField = provider === 'APPLE' ? 'appleSub' : 'googleSub';

  // 1. Match por sub (login de SSO user existente)
  const existingBySub = await prisma.user.findUnique({
    where: { [subField]: sub } as any,
  });
  if (existingBySub) {
    return { user: existingBySub, isNewUser: false, linked: false };
  }

  // 2. Match por email verificado (linkeo automático)
  if (email && emailVerified) {
    const normalizedEmail = email.toLowerCase().trim();
    const existingByEmail = await prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (existingByEmail) {
      const updated = await prisma.user.update({
        where: { id: existingByEmail.id },
        data: {
          [subField]: sub,
          verified: true,
        } as any,
      });
      logger.log(`[SSO] Linkeo automático ${provider} → user ${existingByEmail.id} (${normalizedEmail})`);
      return { user: updated, isNewUser: false, linked: true };
    }
  }

  // 3. Crear user nuevo
  if (!email) {
    throw new Error('SSO_NO_EMAIL_NO_MATCH');
  }
  const normalizedEmail = email.toLowerCase().trim();
  const safeName = (name && name.trim()) || normalizedEmail.split('@')[0];
  const safeLastName = (lastName && lastName.trim()) || '-';

  const created = await prisma.user.create({
    data: {
      email: normalizedEmail,
      name: safeName,
      lastName: safeLastName,
      password: null,
      verified: true,
      authProvider: provider,
      [subField]: sub,
    } as any,
  });

  // Suscripción FREE por defecto — mismo patrón que register.
  await prisma.subscription.create({
    data: { userId: created.id, status: 'ACTIVE', plan: 'FREE' },
  });

  logger.log(`[SSO] Usuario nuevo creado vía ${provider}: ${created.id} (${normalizedEmail})`);
  return { user: created, isNewUser: true, linked: false };
}

// ============================================
// CONTROLLERS
// ============================================

interface AppleSignInRequest {
  identityToken: string;
  name?: string;
  lastName?: string;
  referralCode?: string;
}

export const appleSignIn = async (req: Request, res: Response) => {
  try {
    const { identityToken, name, lastName, referralCode } = (req.body ?? {}) as AppleSignInRequest;
    if (!identityToken || typeof identityToken !== 'string') {
      return res.status(400).json({ error: 'Validation error', message: 'identityToken es requerido' });
    }

    let verified;
    try {
      verified = await verifyAppleIdentityToken(identityToken);
    } catch (err) {
      logger.warn('[SSO/Apple] identityToken inválido:', err);
      return res.status(401).json({ error: 'Invalid token', message: 'Token de Apple inválido o expirado' });
    }

    let result: SSOResolveResult;
    try {
      result = await resolveSSOUser({
        provider: 'APPLE',
        sub: verified.sub,
        email: verified.email,
        emailVerified: verified.emailVerified,
        // Apple solo manda name en el PRIMER sign-in y en el body del request del SDK,
        // no en el JWT. La app móvil lo pasa por aquí.
        name: name ?? null,
        lastName: lastName ?? null,
      });
    } catch (err: any) {
      if (err?.message === 'SSO_NO_EMAIL_NO_MATCH') {
        return res.status(400).json({
          error: 'No email from provider',
          message: 'Apple no envió el email — vuelve a la app, cierra sesión de Apple y registra de nuevo.',
        });
      }
      throw err;
    }

    if (result.isNewUser) {
      fireCompleteRegistration(result.user, req);
      await applyReferralIfPresent(result.user.id, result.user.email, referralCode);
    }

    return res.json(buildLoginResponse(result.user, result.isNewUser, result.linked));
  } catch (error) {
    logger.error('[SSO/Apple] Error:', error);
    return res.status(500).json({ error: 'Internal server error', message: 'Error en Sign in with Apple' });
  }
};

interface GoogleSignInRequest {
  idToken: string;
  referralCode?: string;
}

export const googleSignIn = async (req: Request, res: Response) => {
  try {
    const { idToken, referralCode } = (req.body ?? {}) as GoogleSignInRequest;
    if (!idToken || typeof idToken !== 'string') {
      return res.status(400).json({ error: 'Validation error', message: 'idToken es requerido' });
    }

    let verified;
    try {
      verified = await verifyGoogleIdToken(idToken);
    } catch (err) {
      logger.warn('[SSO/Google] idToken inválido:', err);
      return res.status(401).json({ error: 'Invalid token', message: 'Token de Google inválido o expirado' });
    }

    let result: SSOResolveResult;
    try {
      result = await resolveSSOUser({
        provider: 'GOOGLE',
        sub: verified.sub,
        email: verified.email,
        emailVerified: verified.emailVerified,
        name: verified.givenName,
        lastName: verified.familyName,
      });
    } catch (err: any) {
      if (err?.message === 'SSO_NO_EMAIL_NO_MATCH') {
        return res.status(400).json({
          error: 'No email from provider',
          message: 'Google no envió el email — intenta de nuevo.',
        });
      }
      throw err;
    }

    if (result.isNewUser) {
      fireCompleteRegistration(result.user, req);
      await applyReferralIfPresent(result.user.id, result.user.email, referralCode);
    }

    return res.json(buildLoginResponse(result.user, result.isNewUser, result.linked));
  } catch (error) {
    logger.error('[SSO/Google] Error:', error);
    return res.status(500).json({ error: 'Internal server error', message: 'Error en Sign in with Google' });
  }
};
