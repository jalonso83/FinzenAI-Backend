import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { isOnboardingSkipEnabled } from './config';

import { logger } from '../utils/logger';
export const saveOnboarding = async (req: Request, res: Response) => {
  try {
    const { userId, answers } = req.body;
    if (!userId || !answers) {
      return res.status(400).json({ error: 'userId y answers son requeridos' });
    }

    // Mapeo de campos del assistant a la base de datos
    const {
      nombre_usuario,
      meta_financiera,
      desafio_financiero,
      habito_ahorro,
      fondo_emergencia,
      sentir_financiero,
      rango_ingresos
    } = answers;

    if (!meta_financiera || !desafio_financiero || !habito_ahorro || !fondo_emergencia) {
      return res.status(400).json({ error: 'Faltan campos requeridos en las respuestas de onboarding' });
    }

    // Si el desafío es "Otro", buscar si hay texto adicional
    let mainChallenge = desafio_financiero;
    let mainChallengeOther = undefined;
    if (desafio_financiero.toLowerCase().includes('otro')) {
      mainChallenge = 'Otro';
      mainChallengeOther = desafio_financiero;
    }

    // Guardar respuestas en la tabla Onboarding
    await prisma.onboarding.upsert({
      where: { userId },
      update: {
        mainGoals: meta_financiera,
        mainChallenge,
        mainChallengeOther,
        savingHabit: habito_ahorro,
        emergencyFund: fondo_emergencia,
        financialFeeling: sentir_financiero,
        incomeRange: rango_ingresos
      },
      create: {
        userId,
        mainGoals: meta_financiera,
        mainChallenge,
        mainChallengeOther,
        savingHabit: habito_ahorro,
        emergencyFund: fondo_emergencia,
        financialFeeling: sentir_financiero,
        incomeRange: rango_ingresos
      },
    });

    // Marcar usuario como onboarding y onboardingCompleted
    await prisma.user.update({
      where: { id: userId },
      data: { onboarding: true, onboardingCompleted: true },
    });

    return res.json({ message: 'Onboarding completado y guardado' });
  } catch (error) {
    logger.error('Error guardando onboarding:', error);
    return res.status(500).json({ error: 'Error guardando onboarding' });
  }
};

/**
 * Campos del usuario devueltos al cliente tras saltar el onboarding.
 * Mismo shape que USER_PROFILE_SELECT en auth.ts + nuevos campos de skip
 * para que la app pueda decidir si mostrar el banner de personalización.
 */
const SKIP_RESPONSE_SELECT = {
  id: true,
  name: true,
  lastName: true,
  email: true,
  phone: true,
  birthDate: true,
  country: true,
  state: true,
  city: true,
  currency: true,
  preferredLanguage: true,
  occupation: true,
  company: true,
  verified: true,
  onboardingCompleted: true,
  onboardingMethod: true,
  onboardingSkippedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * POST /api/auth/onboarding/skip
 *
 * Marca el onboarding como saltado y devuelve el usuario actualizado.
 * Idempotente: si ya está marcado como completado/saltado, lo deja como está
 * y devuelve el estado actual sin error.
 *
 * Verifica feature flag por usuario antes de proceder.
 */
export const skipOnboarding = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Usuario no autenticado' });
    }

    if (!isOnboardingSkipEnabled(userId)) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'Esta funcionalidad no está disponible para tu cuenta.',
      });
    }

    // Update atómico: solo modifica si todavía no estaba completado.
    // Esto elimina la race condition de "leer-decidir-escribir" si dos
    // requests llegan en paralelo.
    const updateResult = await prisma.user.updateMany({
      where: { id: userId, onboardingCompleted: false },
      data: {
        onboardingCompleted: true,
        onboardingMethod: 'skipped',
        onboardingSkippedAt: new Date(),
      },
    });

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: SKIP_RESPONSE_SELECT,
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found', message: 'Usuario no encontrado' });
    }

    const alreadyCompleted = updateResult.count === 0;

    return res.json({
      message: alreadyCompleted
        ? 'El onboarding ya estaba marcado como completado.'
        : 'Onboarding saltado exitosamente.',
      user,
      alreadyCompleted,
    });
  } catch (error) {
    logger.error('[Onboarding] Error skipping onboarding:', error);
    return res.status(500).json({
      error: 'Internal Server Error',
      message: 'No se pudo saltar el onboarding.',
    });
  }
};
