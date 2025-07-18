import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { sendVerificationEmail } from '../services/emailService';

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
      company
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
    // Enviar email de verificación
    await sendVerificationEmail(user.email, user.id, name);
    return res.status(201).json({
      message: 'Usuario registrado exitosamente. Por favor revisa tu email para verificar tu cuenta.',
      user: {
        id: user.id,
        email: user.email,
        verified: user.verified
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
        message: 'If an account with that email exists, a password reset link has been sent'
      });
    }

    // Generar token de reset (implementación simplificada)
    const resetToken = jwt.sign(
      { userId: user.id },
      process.env.JWT_SECRET!,
      { expiresIn: '1h' }
    );

    // Enviar email de reset (implementar en emailService)
    // await sendPasswordResetEmail(user.email, resetToken);

    return res.json({
      message: 'If an account with that email exists, a password reset link has been sent'
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
    const { token, newPassword } = req.body;

    if (!token || !newPassword) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'Token and new password are required'
      });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'Password must be at least 6 characters long'
      });
    }

    // Verificar token
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as any;
    
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId }
    });

    if (!user) {
      return res.status(400).json({
        error: 'Invalid token',
        message: 'Invalid or expired reset token'
      });
    }

    // Encriptar nueva contraseña
    const hashedPassword = await bcrypt.hash(newPassword, 12);

    // Actualizar contraseña
    await prisma.user.update({
      where: { id: user.id },
      data: { password: hashedPassword }
    });

    return res.json({
      message: 'Password reset successfully'
    });
  } catch (error) {
    console.error('Reset password error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to reset password'
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