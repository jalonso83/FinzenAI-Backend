import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';
import { ENV } from '../config/env';
import { sendVerificationEmail, sendPasswordResetEmail } from '../services/emailService';
import { TrialScheduler } from '../services/trialScheduler';
import { ReferralService } from '../services/referralService';
import { REFERRAL_CONFIG } from '../config/referralConfig';

import { logger } from '../utils/logger';

// Constantes
const MIN_PASSWORD_LENGTH = 6;
const BCRYPT_ROUNDS = 12;

// Tipos para las peticiones
interface RegisterRequest {
  name: string;
  lastName: string;
  email: string;
  password: string;
  phone: string;
  birthDate: string;
  country: string;
  state: string;
  city: string;
  currency: string;
  preferredLanguage: string;
  occupation: string;
  company?: string;
  // Información del dispositivo para control de trial (anti-abuso)
  deviceId?: string;
  devicePlatform?: string;
  deviceName?: string;
  // Código de referido (opcional)
  referralCode?: string;
}

interface LoginRequest {
  email: string;
  password: string;
}

interface VerifyEmailRequest {
  email: string;
  token: string;
}

// ============================================
// HELPER FUNCTIONS - Extraídas para legibilidad
// ============================================

/**
 * Valida los datos de registro
 */
function validateRegistrationData(data: RegisterRequest): { valid: boolean; error?: string } {
  const { name, lastName, email, password, phone, birthDate, country, state, city, currency, preferredLanguage, occupation } = data;

  if (!name || !lastName || !email || !password || !phone || !birthDate || !country || !state || !city || !currency || !preferredLanguage || !occupation) {
    return { valid: false, error: 'Todos los campos obligatorios deben ser completados' };
  }

  if (password.length < MIN_PASSWORD_LENGTH) {
    return { valid: false, error: `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres` };
  }

  return { valid: true };
}

/**
 * Envía email de verificación sin bloquear el registro
 */
async function sendVerificationEmailSafe(email: string, userId: string, name: string): Promise<void> {
  try {
    await sendVerificationEmail(email, userId, name);
  } catch (emailError) {
    logger.error('❌ Error enviando email de verificación:', emailError);
  }
}

/**
 * Inicia período de prueba sin bloquear el registro
 */
async function startUserTrial(
  userId: string,
  deviceInfo: { deviceId?: string; platform?: string; deviceName?: string }
): Promise<{ success: boolean; trialStarted: boolean; reason?: string }> {
  try {
    return await TrialScheduler.startTrialForUser(userId, deviceInfo);
  } catch (trialError) {
    logger.error('❌ Error iniciando trial:', trialError);
    return { success: false, trialStarted: false };
  }
}

/**
 * Campos de selección del perfil de usuario (evita repetición)
 */
const USER_PROFILE_SELECT = {
  id: true, name: true, lastName: true, email: true, phone: true,
  birthDate: true, country: true, state: true, city: true,
  currency: true, preferredLanguage: true, occupation: true, company: true,
  verified: true, onboardingCompleted: true, createdAt: true, updatedAt: true
} as const;

/**
 * Valida campos obligatorios del perfil
 */
function validateProfileData(data: {
  name?: string; lastName?: string; email?: string; phone?: string;
  birthDate?: string; country?: string; state?: string; city?: string;
  currency?: string; preferredLanguage?: string; occupation?: string;
}): { valid: boolean; error?: string } {
  const { name, lastName, email, phone, birthDate, country, state, city, currency, preferredLanguage, occupation } = data;

  if (!name || !lastName || !email || !phone || !birthDate || !country || !state || !city || !currency || !preferredLanguage || !occupation) {
    return { valid: false, error: 'Todos los campos obligatorios deben ser completados' };
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return { valid: false, error: 'Email inválido' };
  }

  return { valid: true };
}

/**
 * Verifica si el email ya está en uso por otro usuario
 */
async function isEmailTakenByOther(email: string, excludeUserId: string): Promise<boolean> {
  const existingUser = await prisma.user.findFirst({
    where: { email, id: { not: excludeUserId } }
  });
  return !!existingUser;
}

/**
 * Procesa código de referido sin bloquear el registro
 */
async function processReferralCode(
  userId: string,
  email: string,
  referralCode: string
): Promise<{ applied: boolean; discount: string | null; reason?: string }> {
  try {
    const fraudCheck = await ReferralService.checkFraudIndicators('', email);

    if (fraudCheck.suspicious) {
      logger.warn(`⚠️ Referido sospechoso detectado para ${email}: ${fraudCheck.reasons.join(', ')}`);
      return { applied: false, discount: null, reason: 'SUSPICIOUS_REFERRAL' };
    }

    const result = await ReferralService.applyReferralCode(userId, email, referralCode);

    if (result.success) {
      logger.log(`✅ Código de referido aplicado: ${referralCode} para usuario ${userId}`);
    }

    return {
      applied: result.success,
      discount: result.success ? `${result.discountPercent}%` : null,
      reason: result.reason
    };
  } catch (referralError) {
    logger.error('❌ Error aplicando código de referido:', referralError);
    return { applied: false, discount: null };
  }
}

// ============================================
// CONTROLLERS
// ============================================

export const register = async (req: Request, res: Response) => {
  try {
    const registerData: RegisterRequest = req.body;
    const { name, lastName, email, password, phone, birthDate, country, state, city, currency, preferredLanguage, occupation, company, deviceId, devicePlatform, deviceName, referralCode } = registerData;

    // 1. Validar datos de entrada
    const validation = validateRegistrationData(registerData);
    if (!validation.valid) {
      return res.status(400).json({ error: 'Validation error', message: validation.error });
    }

    // 2. Verificar si el usuario ya existe
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return res.status(409).json({ error: 'User already exists', message: 'Ya existe una cuenta con este email' });
    }

    // 3. Crear usuario en base de datos
    const hashedPassword = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const user = await prisma.user.create({
      data: {
        name, lastName, email, password: hashedPassword, phone,
        birthDate: new Date(birthDate), country, state, city,
        currency, preferredLanguage, occupation, company, verified: false
      },
      select: { id: true, email: true, verified: true, createdAt: true }
    });

    // 4. Procesos secundarios (no bloquean el registro)
    await sendVerificationEmailSafe(user.email, user.id, name);

    const trialResult = await startUserTrial(user.id, {
      deviceId, platform: devicePlatform, deviceName
    });

    const referralResult = (referralCode && REFERRAL_CONFIG.ENABLED)
      ? await processReferralCode(user.id, email, referralCode)
      : { applied: false, discount: null, reason: undefined };

    // 5. Respuesta exitosa
    return res.status(201).json({
      message: 'Usuario registrado exitosamente. Por favor revisa tu email para verificar tu cuenta.',
      user: { id: user.id, email: user.email, verified: user.verified },
      trial: { started: trialResult.trialStarted, reason: trialResult.reason },
      referral: { applied: referralResult.applied, discount: referralResult.discount, reason: referralResult.reason }
    });
  } catch (error) {
    logger.error('Register error:', error);
    return res.status(500).json({ error: 'Internal server error', message: 'Error al registrar usuario' });
  }
};

export const login = async (req: Request, res: Response) => {
  try {
    const { email, password }: LoginRequest = req.body;

    // Validaciones básicas
    if (!email || !password) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'Email and password are required'
      });
    }

    // Buscar usuario
    const user = await prisma.user.findUnique({
      where: { email }
    });

    if (!user) {
      return res.status(401).json({
        error: 'Authentication failed',
        message: 'Invalid email or password'
      });
    }

    // Verificar contraseña
    const isValidPassword = await bcrypt.compare(password, user.password);

    if (!isValidPassword) {
      return res.status(401).json({
        error: 'Authentication failed',
        message: 'Invalid email or password'
      });
    }

    // Verificar si el email está verificado
    if (!user.verified) {
      return res.status(403).json({
        error: 'Email not verified',
        message: 'Please verify your email before logging in'
      });
    }

    // Generar token JWT
    const token = jwt.sign(
      { userId: user.id, email: user.email },
      ENV.JWT_SECRET,
      { expiresIn: '7d' }
    );

    return res.json({
      message: 'Login successful',
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        verified: user.verified,
        onboardingCompleted: user.onboardingCompleted
      }
    });
  } catch (error) {
    logger.error('Login error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to login'
    });
  }
};

export const verifyEmail = async (req: Request, res: Response) => {
  try {
    const { email, token }: VerifyEmailRequest = req.body;

    if (!email || !token) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'Email and token are required'
      });
    }

    // Buscar usuario
    const user = await prisma.user.findUnique({
      where: { email }
    });

    if (!user) {
      return res.status(404).json({
        error: 'User not found',
        message: 'Invalid email'
      });
    }

    if (user.verified) {
      return res.status(400).json({
        error: 'Already verified',
        message: 'Email is already verified'
      });
    }

    // Verificar token (implementación simplificada)
    // En producción, deberías usar un token más seguro
    if (token === user.id) {
      await prisma.user.update({
        where: { id: user.id },
        data: { verified: true }
      });

      return res.json({
        message: 'Email verified successfully',
        user: {
          id: user.id,
          email: user.email,
          verified: true
        }
      });
    } else {
      return res.status(400).json({
        error: 'Invalid token',
        message: 'Invalid verification token'
      });
    }
  } catch (error) {
    logger.error('Verify email error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to verify email'
    });
  }
};

// Función para generar código de 6 dígitos
const generateResetCode = (): string => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

export const forgotPassword = async (req: Request, res: Response) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'Email is required'
      });
    }

    const user = await prisma.user.findUnique({
      where: { email }
    });

    if (!user) {
      // Por seguridad, no revelamos si el email existe o no
      return res.json({
        message: 'Si existe una cuenta con ese email, se ha enviado un código de recuperación'
      });
    }

    // Generar código de 6 dígitos
    const resetCode = generateResetCode();
    const resetCodeExpires = new Date(Date.now() + 15 * 60 * 1000); // 15 minutos

    // Guardar código en la base de datos
    await prisma.user.update({
      where: { id: user.id },
      data: {
        resetCode,
        resetCodeExpires
      }
    });

    // Enviar email con código de 6 dígitos
    await sendPasswordResetEmail(user.email, resetCode, user.name);

    return res.json({
      message: 'Si existe una cuenta con ese email, se ha enviado un código de recuperación'
    });
  } catch (error) {
    logger.error('Forgot password error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to process password reset request'
    });
  }
};

export const resetPassword = async (req: Request, res: Response) => {
  try {
    const { email, resetCode, newPassword } = req.body;

    if (!email || !resetCode || !newPassword) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'Email, código de verificación y nueva contraseña son requeridos'
      });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'La contraseña debe tener al menos 6 caracteres'
      });
    }

    // Buscar el usuario con el código de reset válido
    const user = await prisma.user.findUnique({
      where: { email }
    });

    if (!user || !user.resetCode || !user.resetCodeExpires) {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'Código de verificación inválido o expirado'
      });
    }

    // Verificar si el código coincide
    if (user.resetCode !== resetCode) {
      return res.status(400).json({
        error: 'Invalid code',
        message: 'El código de verificación es incorrecto'
      });
    }

    // Verificar si el código no ha expirado
    if (new Date() > user.resetCodeExpires) {
      return res.status(400).json({
        error: 'Expired code',
        message: 'El código de verificación ha expirado. Solicita uno nuevo'
      });
    }

    // Hashear la nueva contraseña
    const hashedPassword = await bcrypt.hash(newPassword, 12);

    // Actualizar la contraseña y limpiar los campos de reset
    await prisma.user.update({
      where: { id: user.id },
      data: {
        password: hashedPassword,
        resetCode: null,
        resetCodeExpires: null
      }
    });

    return res.json({
      message: 'Tu contraseña ha sido actualizada exitosamente'
    });
  } catch (error) {
    logger.error('Reset password error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: 'Error al restablecer la contraseña'
    });
  }
};

export const changePassword = async (req: Request, res: Response) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Usuario no autenticado'
      });
    }

    // Validaciones básicas
    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'La contraseña actual y la nueva contraseña son requeridas'
      });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'La nueva contraseña debe tener al menos 6 caracteres'
      });
    }

    // Obtener usuario actual
    const user = await prisma.user.findUnique({
      where: { id: userId }
    });

    if (!user) {
      return res.status(404).json({
        error: 'User not found',
        message: 'Usuario no encontrado'
      });
    }

    // Verificar contraseña actual
    const isValidCurrentPassword = await bcrypt.compare(currentPassword, user.password);

    if (!isValidCurrentPassword) {
      return res.status(400).json({
        error: 'Invalid password',
        message: 'La contraseña actual es incorrecta'
      });
    }

    // Verificar que la nueva contraseña sea diferente
    const isSamePassword = await bcrypt.compare(newPassword, user.password);

    if (isSamePassword) {
      return res.status(400).json({
        error: 'Same password',
        message: 'La nueva contraseña debe ser diferente a la actual'
      });
    }

    // Encriptar nueva contraseña
    const hashedNewPassword = await bcrypt.hash(newPassword, 12);

    // Actualizar contraseña
    await prisma.user.update({
      where: { id: userId },
      data: { password: hashedNewPassword }
    });

    return res.json({
      message: 'Contraseña cambiada exitosamente'
    });

  } catch (error) {
    logger.error('Change password error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: 'Error al cambiar la contraseña'
    });
  }
};

// Verificar elegibilidad para trial (antes de registro)
export const checkTrialEligibility = async (req: Request, res: Response) => {
  try {
    const { deviceId } = req.body;

    // Si no se proporciona deviceId, asumimos que es elegible (por ahora)
    if (!deviceId) {
      return res.json({
        eligible: true,
        message: 'Dispositivo elegible para período de prueba'
      });
    }

    // Verificar si el dispositivo ya usó un trial
    const deviceUsedTrial = await TrialScheduler.hasDeviceUsedTrial(deviceId);

    if (deviceUsedTrial) {
      return res.json({
        eligible: false,
        reason: 'DEVICE_ALREADY_USED_TRIAL',
        message: 'Este dispositivo ya utilizó el período de prueba gratuito'
      });
    }

    return res.json({
      eligible: true,
      message: 'Dispositivo elegible para período de prueba'
    });

  } catch (error) {
    logger.error('Check trial eligibility error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: 'Error al verificar elegibilidad'
    });
  }
};

// Obtener perfil del usuario
export const getProfile = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Usuario no autenticado' });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: USER_PROFILE_SELECT
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found', message: 'Usuario no encontrado' });
    }

    return res.json(user);
  } catch (error) {
    logger.error('Get profile error:', error);
    return res.status(500).json({ error: 'Internal server error', message: 'Error al obtener perfil' });
  }
};

// Actualizar perfil del usuario
export const updateProfile = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Usuario no autenticado' });
    }

    const { name, lastName, email, phone, birthDate, country, state, city, currency, preferredLanguage, occupation, company } = req.body;

    // 1. Validar datos
    const validation = validateProfileData(req.body);
    if (!validation.valid) {
      return res.status(400).json({ error: 'Validation error', message: validation.error });
    }

    // 2. Verificar email único
    if (await isEmailTakenByOther(email, userId)) {
      return res.status(409).json({ error: 'Email already exists', message: 'Ya existe una cuenta con este email' });
    }

    // 3. Actualizar usuario
    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: {
        name, lastName, email, phone, birthDate: new Date(birthDate),
        country, state, city, currency, preferredLanguage, occupation, company
      },
      select: USER_PROFILE_SELECT
    });

    return res.json({ message: 'Perfil actualizado exitosamente', user: updatedUser });
  } catch (error) {
    logger.error('Update profile error:', error);
    return res.status(500).json({ error: 'Internal server error', message: 'Error al actualizar perfil' });
  }
};