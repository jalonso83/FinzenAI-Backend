import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';
import { ENV } from '../config/env';
import { GamificationService } from '../services/gamificationService';
import { logger } from '../utils/logger';

// Extender la interfaz Request para incluir el usuario
declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        email: string;
      };
    }
  }
}

// Tracks which users have already had `daily_open` dispatched today (UTC).
// Bounds memory to ~unique-active-users-per-day; the handler does a DB-level
// dedup as a second safety net (server restart / multi-instance).
const dailyOpenSeen = new Map<string, string>();

export const authenticateToken = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    if (!token) {
      return res.status(401).json({
        error: 'Access denied',
        message: 'No token provided'
      });
    }

    const decoded = jwt.verify(token, ENV.JWT_SECRET, { algorithms: ['HS256'] }) as any;
    
    // Verificar que el usuario existe en la base de datos
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: { id: true, email: true, verified: true }
    });

    if (!user) {
      return res.status(401).json({
        error: 'Access denied',
        message: 'Invalid token'
      });
    }

    if (!user.verified) {
      return res.status(403).json({
        error: 'Access denied',
        message: 'Email not verified'
      });
    }

    req.user = {
      id: user.id,
      email: user.email
    };

    // Mark user as active today (DAU/MAU). Fire-and-forget — never block the request.
    const todayKey = new Date().toISOString().slice(0, 10);
    if (dailyOpenSeen.get(user.id) !== todayKey) {
      dailyOpenSeen.set(user.id, todayKey);
      GamificationService.dispatchEvent({
        userId: user.id,
        eventType: 'daily_open',
      }).catch(err => logger.error('[Auth] daily_open dispatch failed', err));
    }

    return next();
  } catch (error) {
    return res.status(401).json({
      error: 'Access denied',
      message: 'Invalid token'
    });
  }
}; 