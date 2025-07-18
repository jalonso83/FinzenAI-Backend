import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

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
    console.error('Error guardando onboarding:', error);
    return res.status(500).json({ error: 'Error guardando onboarding' });
  }
}; 