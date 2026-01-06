import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { sendVerificationEmail, sendPasswordResetEmail } from '../services/emailService';
import { TrialScheduler } from '../services/trialScheduler';
import { ReferralService } from '../services/referralService';
import { REFERRAL_CONFIG } from '../config/referralConfig';

const prisma = new PrismaClient();

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

export const register = async (req: Request, res: Response) => {
  try {
    const {
      name,
      lastName,
      email,
      password,
      phone,
      birthDate,
      country,
      state,
      city,
      currency,
      preferredLanguage,
      occupation,
      company,
      deviceId,
      devicePlatform,
      deviceName,
      referralCode
    }: RegisterRequest = req.body;

    // Validaciones básicas
    if (!name || !lastName || !email || !password || !phone || !birthDate || !country || !state || !city || !currency || !preferredLanguage || !occupation) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'Todos los campos obligatorios deben ser completados'
      });
    }
    if (password.length < 6) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'La contraseña debe tener al menos 6 caracteres'
      });
    }
    // Verificar si el usuario ya existe
    const existingUser = await prisma.user.findUnique({
      where: { email }
    });
    if (existingUser) {
      return res.status(409).json({
        error: 'User already exists',
        message: 'Ya existe una cuenta con este email'
      });
    }
    // Encriptar contraseña
    const hashedPassword = await bcrypt.hash(password, 12);
    // Crear usuario
    const user = await prisma.user.create({
      data: {
        name,
        lastName,
        email,
        password: hashedPassword,
        phone,
        birthDate: new Date(birthDate),
        country,
        state,
        city,
        currency,
        preferredLanguage,
        occupation,
        company,
        verified: false
      },
      select: {
        id: true,
        email: true,
        verified: true,
        createdAt: true
      }
    });
    // Enviar email de verificación (no bloquear el registro si falla)
    try {
      await sendVerificationEmail(user.email, user.id, name);
    } catch (emailError) {
      console.error('❌ Error enviando email de verificación:', emailError);
      // No fallar el registro por error de email
    }

    // Iniciar período de prueba de 7 días (no bloquear el registro si falla)
    let trialResult = { success: false, trialStarted: false, reason: undefined as string | undefined };
    try {
      trialResult = await TrialScheduler.startTrialForUser(user.id, {
        deviceId,
        platform: devicePlatform,
        deviceName
      });
    } catch (trialError) {
      console.error('❌ Error iniciando trial:', trialError);
      // No fallar el registro por error de trial
    }

    // Procesar código de referido si se proporciona (no bloquear el registro si falla)
    let referralResult = { applied: false, discount: null as string | null, reason: undefined as string | undefined };
    if (referralCode && REFERRAL_CONFIG.ENABLED) {
      try {
        // Verificar anti-fraude antes de aplicar
        const fraudCheck = await ReferralService.checkFraudIndicators('', email);

        if (!fraudCheck.suspicious) {
          const result = await ReferralService.applyReferralCode(user.id, email, referralCode);
          referralResult = {
            applied: result.success,
            discount: result.success ? `${result.discountPercent}%` : null,
            reason: result.reason
          };

          if (result.success) {
            console.log(`✅ Código de referido aplicado: ${referralCode} para usuario ${user.id}`);
          }
        } else {
          console.warn(`⚠️ Referido sospechoso detectado para ${email}: ${fraudCheck.reasons.join(', ')}`);
          referralResult.reason = 'SUSPICIOUS_REFERRAL';
        }
      } catch (referralError) {
        console.error('❌ Error aplicando código de referido:', referralError);
        // No fallar el registro por error de referido
      }
    }

    return res.status(201).json({
      message: 'Usuario registrado exitosamente. Por favor revisa tu email para verificar tu cuenta.',
      user: {
        id: user.id,
        email: user.email,
        verified: user.verified
      },
      trial: {
        started: trialResult.trialStarted,
        reason: trialResult.reason // 'EMAIL_ALREADY_USED_TRIAL' | 'DEVICE_ALREADY_USED_TRIAL' | undefined
      },
      referral: {
        applied: referralResult.applied,
        discount: referralResult.discount,
        reason: referralResult.reason
      }
    });
  } catch (error) {
    console.error('Register error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: 'Error al registrar usuario'
    });
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
      process.env.JWT_SECRET!,
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
    console.error('Login error:', error);
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
    console.error('Verify email error:', error);
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
    console.error('Forgot password error:', error);
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
    console.error('Reset password error:', error);
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
    console.error('Change password error:', error);
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
    console.error('Check trial eligibility error:', error);
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
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Usuario no autenticado'
      });
    }
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
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
        createdAt: true,
        updatedAt: true
      }
    });
    if (!user) {
      return res.status(404).json({
        error: 'User not found',
        message: 'Usuario no encontrado'
      });
    }
    return res.json(user);
  } catch (error) {
    console.error('Get profile error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: 'Error al obtener perfil'
    });
  }
};

// Actualizar perfil del usuario
export const updateProfile = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Usuario no autenticado'
      });
    }
    const {
      name,
      lastName,
      email,
      phone,
      birthDate,
      country,
      state,
      city,
      currency,
      preferredLanguage,
      occupation,
      company
    } = req.body;
    // Validaciones básicas
    if (!name || !lastName || !email || !phone || !birthDate || !country || !state || !city || !currency || !preferredLanguage || !occupation) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'Todos los campos obligatorios deben ser completados'
      });
    }
    // Validar email
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'Email inválido'
      });
    }
    // Verificar si el email ya existe en otro usuario
    const existingUser = await prisma.user.findFirst({
      where: {
        email,
        id: { not: userId }
      }
    });
    if (existingUser) {
      return res.status(409).json({
        error: 'Email already exists',
        message: 'Ya existe una cuenta con este email'
      });
    }
    // Actualizar usuario
    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: {
        name,
        lastName,
        email,
        phone,
        birthDate: new Date(birthDate),
        country,
        state,
        city,
        currency,
        preferredLanguage,
        occupation,
        company
      },
      select: {
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
        createdAt: true,
        updatedAt: true
      }
    });
    return res.json({
      message: 'Perfil actualizado exitosamente',
      user: updatedUser
    });
  } catch (error) {
    console.error('Update profile error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: 'Error al actualizar perfil'
    });
  }
};