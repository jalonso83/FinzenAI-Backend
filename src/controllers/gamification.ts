import { Request, Response } from 'express';
import { GamificationService } from '../services/gamificationService';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export class GamificationController {
  // Obtener FinScore del usuario
  static async getFinScore(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.user?.id;
      if (!userId) {
        res.status(401).json({ message: 'Usuario no autenticado' });
        return;
      }

      const finScoreData = await GamificationService.getUserFinScore(userId);
      
      // Transformar al formato esperado por el frontend
      const finScore = {
        currentScore: finScoreData.score,
        level: GamificationController.calculateUserLevel(finScoreData.score),
        pointsToNextLevel: GamificationController.calculatePointsToNextLevel(finScoreData.score),
        totalPointsEarned: finScoreData.score,
        breakdown: finScoreData.breakdown
      };
      
      res.json({
        success: true,
        data: finScore
      });
    } catch (error) {
      console.error('[GamificationController] Error obteniendo FinScore:', error);
      res.status(500).json({
        success: false,
        message: 'Error interno del servidor'
      });
    }
  }

  // Obtener historial de FinScore
  static async getFinScoreHistory(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.user?.id;
      if (!userId) {
        res.status(401).json({ message: 'Usuario no autenticado' });
        return;
      }

      const { limit = 30 } = req.query;

      const history = await prisma.finScoreHistory.findMany({
        where: { userId },
        orderBy: { calculatedAt: 'desc' },
        take: parseInt(limit as string)
      });

      res.json({
        success: true,
        data: history
      });
    } catch (error) {
      console.error('[GamificationController] Error obteniendo historial FinScore:', error);
      res.status(500).json({
        success: false,
        message: 'Error interno del servidor'
      });
    }
  }

  // Obtener badges del usuario
  static async getUserBadges(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.user?.id;
      if (!userId) {
        res.status(401).json({ message: 'Usuario no autenticado' });
        return;
      }

      const badges = await GamificationService.getUserBadges(userId);
      
      // Agregar información adicional de cada badge
      const badgesWithInfo = badges.map(badge => ({
        ...badge,
        info: GamificationController.getBadgeInfo(badge.badgeId)
      }));

      res.json({
        success: true,
        data: badgesWithInfo
      });
    } catch (error) {
      console.error('[GamificationController] Error obteniendo badges:', error);
      res.status(500).json({
        success: false,
        message: 'Error interno del servidor'
      });
    }
  }

  // Obtener racha del usuario
  static async getUserStreak(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.user?.id;
      if (!userId) {
        res.status(401).json({ message: 'Usuario no autenticado' });
        return;
      }

      console.log(`[GamificationController] Obteniendo racha para usuario: ${userId}`);
      const streak = await GamificationService.getUserStreak(userId);
      console.log(`[GamificationController] Racha obtenida:`, streak);

      // Debug: Verificar si necesitamos crear racha inicial
      if (!streak) {
        console.log(`[GamificationController] No existe racha para usuario ${userId}, verificando historial...`);
        
        // Verificar si el usuario tiene transacciones
        const transactionCount = await prisma.transaction.count({
          where: { userId }
        });
        
        console.log(`[GamificationController] Usuario tiene ${transactionCount} transacciones`);
        
        if (transactionCount > 0) {
          console.log(`[GamificationController] Usuario tiene transacciones pero no racha, creando racha inicial...`);
          // Crear racha inicial si tiene transacciones pero no racha
          const newStreak = await prisma.userStreak.create({
            data: {
              userId,
              currentStreak: 1,
              longestStreak: 1,
              lastActivityDate: new Date(),
              streakType: 'daily'
            }
          });
          console.log(`[GamificationController] Racha inicial creada:`, newStreak);
          
          res.json({
            success: true,
            data: newStreak
          });
          return;
        }
      }

      res.json({
        success: true,
        data: streak
      });
    } catch (error) {
      console.error('[GamificationController] Error obteniendo racha:', error);
      res.status(500).json({
        success: false,
        message: 'Error interno del servidor'
      });
    }
  }

  // Obtener estadísticas generales de gamificación
  static async getGamificationStats(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.user?.id;
      if (!userId) {
        res.status(401).json({ message: 'Usuario no autenticado' });
        return;
      }

      // Obtener datos paralelos
      const [finScore, badges, streak, recentEvents, totalPoints] = await Promise.all([
        GamificationService.getUserFinScore(userId),
        GamificationService.getUserBadges(userId),
        GamificationService.getUserStreak(userId),
        prisma.gamificationEvent.findMany({
          where: { userId },
          orderBy: { createdAt: 'desc' },
          take: 10
        }),
        prisma.gamificationEvent.aggregate({
          where: { userId },
          _sum: { pointsAwarded: true }
        })
      ]);

      const stats = {
        finScore,
        badges: {
          total: badges.length,
          recent: badges.slice(0, 3),
          featured: badges.filter(b => b.isFeatured)
        },
        streak,
        totalPoints: totalPoints._sum.pointsAwarded || 0,
        recentActivity: recentEvents,
        level: GamificationController.calculateUserLevel(totalPoints._sum.pointsAwarded || 0),
        nextLevelProgress: GamificationController.calculateLevelProgress(totalPoints._sum.pointsAwarded || 0)
      };

      res.json({
        success: true,
        data: stats
      });
    } catch (error) {
      console.error('[GamificationController] Error obteniendo estadísticas:', error);
      res.status(500).json({
        success: false,
        message: 'Error interno del servidor'
      });
    }
  }

  // Recalcular FinScore manualmente
  static async recalculateFinScore(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.user?.id;
      if (!userId) {
        res.status(401).json({ message: 'Usuario no autenticado' });
        return;
      }

      const newScore = await GamificationService.recalculateFinScore(userId);

      res.json({
        success: true,
        data: { score: newScore },
        message: 'FinScore recalculado exitosamente'
      });
    } catch (error) {
      console.error('[GamificationController] Error recalculando FinScore:', error);
      res.status(500).json({
        success: false,
        message: 'Error interno del servidor'
      });
    }
  }

  // Disparar evento de gamificación manualmente (para testing)
  static async dispatchEvent(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.user?.id;
      if (!userId) {
        res.status(401).json({ message: 'Usuario no autenticado' });
        return;
      }

      const { eventType, eventData, pointsAwarded } = req.body;

      if (!eventType) {
        res.status(400).json({
          success: false,
          message: 'Tipo de evento requerido'
        });
        return;
      }

      await GamificationService.dispatchEvent({
        userId,
        eventType,
        eventData,
        pointsAwarded
      });

      res.json({
        success: true,
        message: 'Evento disparado exitosamente'
      });
    } catch (error) {
      console.error('[GamificationController] Error disparando evento:', error);
      res.status(500).json({
        success: false,
        message: 'Error interno del servidor'
      });
    }
  }

  // Obtener eventos recientes de gamificación
  static async getRecentEvents(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.user?.id;
      if (!userId) {
        res.status(401).json({ message: 'Usuario no autenticado' });
        return;
      }

      const { since, limit = 5 } = req.query;
      const sinceDate = since ? new Date(since as string) : new Date(Date.now() - 5 * 60 * 1000); // 5 minutos por defecto

      const events = await prisma.gamificationEvent.findMany({
        where: {
          userId,
          createdAt: { gte: sinceDate },
          eventType: { in: ['add_tx', 'create_budget', 'create_goal', 'goal_complete', 'within_budget'] }
        },
        orderBy: { createdAt: 'desc' },
        take: parseInt(limit as string)
      });

      res.json({
        success: true,
        data: events
      });
    } catch (error) {
      console.error('[GamificationController] Error obteniendo eventos recientes:', error);
      res.status(500).json({
        success: false,
        message: 'Error interno del servidor'
      });
    }
  }

  // Obtener rankings globales
  static async getLeaderboard(req: Request, res: Response): Promise<void> {
    try {
      const { type = 'finscore', limit = 10 } = req.query;

      let leaderboard;

      switch (type) {
        case 'finscore':
          leaderboard = await prisma.finScoreHistory.findMany({
            select: {
              userId: true,
              score: true,
              calculatedAt: true,
              user: {
                select: {
                  name: true,
                  lastName: true
                }
              }
            },
            orderBy: [
              { score: 'desc' },
              { calculatedAt: 'desc' }
            ],
            distinct: ['userId'],
            take: parseInt(limit as string)
          });
          break;

        case 'streak':
          leaderboard = await prisma.userStreak.findMany({
            select: {
              userId: true,
              currentStreak: true,
              longestStreak: true,
              user: {
                select: {
                  name: true,
                  lastName: true
                }
              }
            },
            orderBy: { currentStreak: 'desc' },
            take: parseInt(limit as string)
          });
          break;

        case 'points':
          const pointsLeaderboard = await prisma.gamificationEvent.groupBy({
            by: ['userId'],
            _sum: { pointsAwarded: true },
            orderBy: { _sum: { pointsAwarded: 'desc' } },
            take: parseInt(limit as string)
          });

          // Obtener información de usuarios
          const userIds = pointsLeaderboard.map(entry => entry.userId);
          const users = await prisma.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, name: true, lastName: true }
          });

          leaderboard = pointsLeaderboard.map(entry => ({
            userId: entry.userId,
            totalPoints: entry._sum.pointsAwarded,
            user: users.find(u => u.id === entry.userId)
          }));
          break;

        default:
          res.status(400).json({
            success: false,
            message: 'Tipo de ranking no válido'
          });
          return;
      }

      res.json({
        success: true,
        data: {
          type,
          leaderboard
        }
      });
    } catch (error) {
      console.error('[GamificationController] Error obteniendo leaderboard:', error);
      res.status(500).json({
        success: false,
        message: 'Error interno del servidor'
      });
    }
  }

  // Métodos auxiliares privados
  private static getBadgeInfo(badgeId: string) {
    const badgeInfoMap: { [key: string]: any } = {
      'primer_paso': {
        name: 'Primer Paso',
        description: 'Registraste tu primera transacción',
        icon: '🎯',
        rarity: 'common'
      },
      'planificador': {
        name: 'Planificador',
        description: 'Creaste tu primer presupuesto',
        icon: '📋',
        rarity: 'common'
      },
      'ahorro_rookie': {
        name: 'Ahorro Rookie',
        description: 'Ahorraste por primera vez',
        icon: '🐣',
        rarity: 'common'
      },
      'zenio_lover': {
        name: 'Zenio Lover',
        description: 'Registraste 10 transacciones',
        icon: '💝',
        rarity: 'uncommon'
      },
      'anti_doom_spender': {
        name: 'Anti Doom Spender',
        description: 'Controlaste tus gastos impulsivos',
        icon: '🛡️',
        rarity: 'rare'
      },
      'racha_fuego': {
        name: 'Racha Fuego',
        description: 'Mantuviste una racha de 7 días',
        icon: '🔥',
        rarity: 'uncommon'
      },
      'ahorrador_novato': {
        name: 'Ahorrador Novato',
        description: 'Completaste tu primer reto de ahorro',
        icon: '🌱',
        rarity: 'common'
      },
      'presupuesto_maestro': {
        name: 'Presupuesto Maestro',
        description: 'Cumpliste 3 presupuestos consecutivos',
        icon: '👑',
        rarity: 'rare'
      },
      'meta_crusher': {
        name: 'Meta Crusher',
        description: 'Completaste tu primera meta',
        icon: '💪',
        rarity: 'uncommon'
      }
    };

    return badgeInfoMap[badgeId] || {
      name: 'Badge Desconocido',
      description: 'Descripción no disponible',
      icon: '🏆',
      rarity: 'common'
    };
  }

  private static calculateUserLevel(totalPoints: number): number {
    // Cada nivel requiere más puntos exponencialmente
    const basePoints = 100;
    const level = Math.floor(Math.sqrt(totalPoints / basePoints)) + 1;
    return Math.max(1, level);
  }

  private static calculatePointsToNextLevel(totalPoints: number): number {
    const currentLevel = GamificationController.calculateUserLevel(totalPoints);
    const nextLevelRequiredPoints = Math.pow(currentLevel, 2) * 100;
    const pointsToNext = Math.max(0, nextLevelRequiredPoints - totalPoints);
    return pointsToNext;
  }

  private static calculateLevelProgress(totalPoints: number): { current: number; needed: number; percentage: number } {
    const currentLevel = GamificationController.calculateUserLevel(totalPoints);
    const currentLevelPoints = Math.pow(currentLevel - 1, 2) * 100;
    const nextLevelPoints = Math.pow(currentLevel, 2) * 100;
    
    const progress = totalPoints - currentLevelPoints;
    const needed = nextLevelPoints - currentLevelPoints;
    const percentage = (progress / needed) * 100;

    return {
      current: progress,
      needed,
      percentage: Math.min(100, Math.max(0, percentage))
    };
  }
}