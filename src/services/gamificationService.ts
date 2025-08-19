import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export interface GamificationEventData {
  userId: string;
  eventType: string;
  eventData?: any;
  pointsAwarded?: number;
}

export interface FinScoreBreakdown {
  savings: number;
  budget: number;
  streak: number;
  debt: number;
  activity: number;
}

export class GamificationService {
  // Event Dispatcher System
  static async dispatchEvent(eventData: GamificationEventData): Promise<void> {
    try {
      // Crear evento en la base de datos
      const event = await prisma.gamificationEvent.create({
        data: {
          userId: eventData.userId,
          eventType: eventData.eventType,
          eventData: eventData.eventData || {},
          pointsAwarded: eventData.pointsAwarded || 0
        }
      });

      console.log(`[Gamification] Evento creado: ${eventData.eventType} para usuario ${eventData.userId}`);

      // Procesar el evento según su tipo
      await this.processEvent(event);
    } catch (error) {
      console.error('[Gamification] Error al despachar evento:', error);
      throw error;
    }
  }

  // Procesador principal de eventos
  private static async processEvent(event: any): Promise<void> {
    try {
      switch (event.eventType) {
        case 'add_tx':
          await this.handleTransactionAdded(event);
          break;
        case 'edit_tx':
          await this.handleTransactionEdited(event);
          break;
        case 'delete_tx':
          await this.handleTransactionDeleted(event);
          break;
        case 'create_budget':
          await this.handleBudgetCreated(event);
          break;
        case 'overspend':
          await this.handleBudgetOverspent(event);
          break;
        case 'within_budget':
          await this.handleBudgetWithinLimit(event);
          break;
        case 'create_goal':
          await this.handleGoalCreated(event);
          break;
        case 'goal_contrib':
          await this.handleGoalContribution(event);
          break;
        case 'goal_complete':
          await this.handleGoalCompleted(event);
          break;
        case 'daily_open':
          await this.handleDailyOpen(event);
          break;
        case 'tip_accepted':
          await this.handleTipAccepted(event);
          break;
        case 'tip_ignored':
          await this.handleTipIgnored(event);
          break;
        default:
          console.log(`[Gamification] Tipo de evento no reconocido: ${event.eventType}`);
      }

      // Recalcular FinScore después de cada evento
      await this.recalculateFinScore(event.userId);
      
      // Verificar logros desbloqueados
      await this.checkBadgeUnlocks(event.userId, event.eventType);
      
      // Actualizar rachas
      await this.updateUserStreak(event.userId, event.eventType);
      
    } catch (error) {
      console.error(`[Gamification] Error procesando evento ${event.eventType}:`, error);
    }
  }

  // Handlers específicos para cada tipo de evento
  private static async handleTransactionAdded(event: any): Promise<void> {
    const points = 5; // Puntos por agregar transacción
    await this.awardPoints(event.userId, points, 'Transacción agregada');
  }

  private static async handleTransactionEdited(event: any): Promise<void> {
    const points = 2; // Puntos por editar transacción
    await this.awardPoints(event.userId, points, 'Transacción editada');
  }

  private static async handleTransactionDeleted(event: any): Promise<void> {
    // No otorgar puntos por eliminar, pero registrar actividad
    console.log(`[Gamification] Transacción eliminada por usuario ${event.userId}`);
  }

  private static async handleBudgetCreated(event: any): Promise<void> {
    const points = 20; // Puntos por crear presupuesto
    await this.awardPoints(event.userId, points, 'Presupuesto creado');
  }

  private static async handleBudgetOverspent(event: any): Promise<void> {
    const points = -10; // Penalización por sobrepasar presupuesto
    await this.awardPoints(event.userId, points, 'Presupuesto excedido');
  }

  private static async handleBudgetWithinLimit(event: any): Promise<void> {
    const points = 15; // Puntos por mantener presupuesto
    await this.awardPoints(event.userId, points, 'Presupuesto controlado');
  }

  private static async handleGoalCreated(event: any): Promise<void> {
    const points = 25; // Puntos por crear meta
    await this.awardPoints(event.userId, points, 'Meta creada');
  }

  private static async handleGoalContribution(event: any): Promise<void> {
    const points = 10; // Puntos por contribuir a meta
    await this.awardPoints(event.userId, points, 'Contribución a meta');
  }

  private static async handleGoalCompleted(event: any): Promise<void> {
    const points = 50; // Puntos por completar meta
    await this.awardPoints(event.userId, points, 'Meta completada');
  }

  private static async handleDailyOpen(event: any): Promise<void> {
    const points = 3; // Puntos por abrir la app diariamente
    await this.awardPoints(event.userId, points, 'Apertura diaria');
  }

  private static async handleTipAccepted(event: any): Promise<void> {
    const points = 5; // Puntos por aceptar consejo
    await this.awardPoints(event.userId, points, 'Consejo aceptado');
  }

  private static async handleTipIgnored(event: any): Promise<void> {
    // No penalizar por ignorar consejos, solo registrar
    console.log(`[Gamification] Consejo ignorado por usuario ${event.userId}`);
  }

  // Sistema de puntos
  private static async awardPoints(userId: string, points: number, reason: string): Promise<void> {
    try {
      if (points !== 0) {
        await prisma.gamificationEvent.create({
          data: {
            userId,
            eventType: 'points_awarded',
            eventData: { reason, points },
            pointsAwarded: points
          }
        });
        console.log(`[Gamification] ${points > 0 ? 'Otorgados' : 'Deducidos'} ${Math.abs(points)} puntos a ${userId}: ${reason}`);
      }
    } catch (error) {
      console.error('[Gamification] Error otorgando puntos:', error);
    }
  }

  // Cálculo de FinScore
  static async recalculateFinScore(userId: string): Promise<number> {
    try {
      const breakdown = await this.calculateFinScoreBreakdown(userId);
      const totalScore = Math.min(100, Math.max(0, 
        breakdown.savings + breakdown.budget + breakdown.streak + breakdown.debt + breakdown.activity
      ));

      // Guardar en historial
      await prisma.finScoreHistory.create({
        data: {
          userId,
          score: Math.round(totalScore),
          breakdown: breakdown as any
        }
      });

      console.log(`[Gamification] FinScore actualizado para ${userId}: ${Math.round(totalScore)}`);
      return totalScore;
    } catch (error) {
      console.error('[Gamification] Error calculando FinScore:', error);
      return 0;
    }
  }

  // Desglose detallado del FinScore
  private static async calculateFinScoreBreakdown(userId: string): Promise<FinScoreBreakdown> {
    try {
      // Obtener datos del usuario
      const user = await prisma.user.findUnique({
        where: { id: userId },
        include: {
          transactions: {
            where: {
              createdAt: {
                gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) // Últimos 30 días
              }
            }
          },
          budgets: {
            where: { is_active: true }
          },
          goals: {
            where: { isActive: true }
          },
          userStreak: true,
          gamificationEvents: {
            where: {
              createdAt: {
                gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
              }
            }
          }
        }
      });

      if (!user) {
        return { savings: 0, budget: 0, streak: 0, debt: 0, activity: 0 };
      }

      // 1. Puntuación de Ahorro (0-25 puntos)
      const savings = this.calculateSavingsScore(user);

      // 2. Puntuación de Presupuesto (0-25 puntos)
      const budget = this.calculateBudgetScore(user);

      // 3. Puntuación de Racha (0-20 puntos)
      const streak = this.calculateStreakScore(user.userStreak);

      // 4. Puntuación de Deuda (0-15 puntos) - A implementar
      const debt = 15; // Placeholder: asumir sin deudas por ahora

      // 5. Puntuación de Actividad (0-15 puntos)
      const activity = this.calculateActivityScore(user.gamificationEvents);

      return { savings, budget, streak, debt, activity };
    } catch (error) {
      console.error('[Gamification] Error en desglose FinScore:', error);
      return { savings: 0, budget: 0, streak: 0, debt: 0, activity: 0 };
    }
  }

  private static calculateSavingsScore(user: any): number {
    const incomeTransactions = user.transactions.filter((t: any) => t.type === 'INCOME');
    const expenseTransactions = user.transactions.filter((t: any) => t.type === 'EXPENSE');
    
    const totalIncome = incomeTransactions.reduce((sum: number, t: any) => sum + t.amount, 0);
    const totalExpenses = expenseTransactions.reduce((sum: number, t: any) => sum + t.amount, 0);
    
    if (totalIncome <= 0) return 0;
    
    const savingsRate = ((totalIncome - totalExpenses) / totalIncome) * 100;
    
    if (savingsRate >= 20) return 25;
    if (savingsRate >= 15) return 20;
    if (savingsRate >= 10) return 15;
    if (savingsRate >= 5) return 10;
    return Math.max(0, savingsRate);
  }

  private static calculateBudgetScore(user: any): number {
    if (user.budgets.length === 0) return 5; // Puntuación base por no tener presupuestos
    
    let totalScore = 0;
    let budgetCount = 0;
    
    for (const budget of user.budgets) {
      const usagePercentage = (budget.spent / budget.amount) * 100;
      
      if (usagePercentage <= 80) {
        totalScore += 25;
      } else if (usagePercentage <= 90) {
        totalScore += 20;
      } else if (usagePercentage <= 100) {
        totalScore += 15;
      } else {
        totalScore += 5; // Penalización menor por exceder
      }
      budgetCount++;
    }
    
    return budgetCount > 0 ? totalScore / budgetCount : 0;
  }

  private static calculateStreakScore(userStreak: any): number {
    if (!userStreak) return 0;
    
    const currentStreak = userStreak.currentStreak;
    
    if (currentStreak >= 30) return 20;
    if (currentStreak >= 14) return 15;
    if (currentStreak >= 7) return 10;
    if (currentStreak >= 3) return 5;
    return Math.min(currentStreak, 3);
  }

  private static calculateActivityScore(events: any[]): number {
    const eventCount = events.length;
    
    if (eventCount >= 50) return 15;
    if (eventCount >= 30) return 12;
    if (eventCount >= 20) return 10;
    if (eventCount >= 10) return 7;
    if (eventCount >= 5) return 5;
    return Math.min(eventCount, 5);
  }

  // Sistema de badges
  static async checkBadgeUnlocks(userId: string, eventType: string): Promise<void> {
    try {
      const badges = await this.getBadgesToCheck(eventType);
      
      for (const badgeId of badges) {
        const hasEarned = await this.checkBadgeEarned(userId, badgeId);
        if (hasEarned) {
          await this.awardBadge(userId, badgeId);
        }
      }
    } catch (error) {
      console.error('[Gamification] Error verificando badges:', error);
    }
  }

  private static async getBadgesToCheck(eventType: string): Promise<string[]> {
    const badgeMap: { [key: string]: string[] } = {
      'add_tx': ['primer_paso', 'zenio_lover'],
      'create_budget': ['planificador'],
      'goal_complete': ['meta_crusher'],
      'within_budget': ['presupuesto_maestro'],
      'daily_open': ['racha_fuego']
    };
    
    return badgeMap[eventType] || [];
  }

  private static async checkBadgeEarned(userId: string, badgeId: string): Promise<boolean> {
    // Verificar si ya tiene el badge
    const existingBadge = await prisma.userBadge.findUnique({
      where: { userId_badgeId: { userId, badgeId } }
    });
    
    if (existingBadge) return false;
    
    // Lógica específica para cada badge
    switch (badgeId) {
      case 'primer_paso':
        return await this.checkPrimerPaso(userId);
      case 'planificador':
        return await this.checkPlanificador(userId);
      case 'zenio_lover':
        return await this.checkZenioLover(userId);
      case 'presupuesto_maestro':
        return await this.checkPresupuestoMaestro(userId);
      case 'meta_crusher':
        return await this.checkMetaCrusher(userId);
      case 'racha_fuego':
        return await this.checkRachaFuego(userId);
      default:
        return false;
    }
  }

  // Verificaciones específicas de badges
  private static async checkPrimerPaso(userId: string): Promise<boolean> {
    const transactionCount = await prisma.transaction.count({
      where: { userId }
    });
    return transactionCount >= 1;
  }

  private static async checkPlanificador(userId: string): Promise<boolean> {
    const budgetCount = await prisma.budget.count({
      where: { user_id: userId }
    });
    return budgetCount >= 1;
  }

  private static async checkZenioLover(userId: string): Promise<boolean> {
    const eventCount = await prisma.gamificationEvent.count({
      where: { 
        userId,
        eventType: 'add_tx'
      }
    });
    return eventCount >= 10;
  }

  private static async checkPresupuestoMaestro(userId: string): Promise<boolean> {
    const successfulBudgets = await prisma.budget.count({
      where: {
        user_id: userId,
        spent: { lte: prisma.budget.fields.amount }
      }
    });
    return successfulBudgets >= 3;
  }

  private static async checkMetaCrusher(userId: string): Promise<boolean> {
    const completedGoals = await prisma.goal.count({
      where: {
        userId,
        isCompleted: true
      }
    });
    return completedGoals >= 1;
  }

  private static async checkRachaFuego(userId: string): Promise<boolean> {
    const userStreak = await prisma.userStreak.findUnique({
      where: { userId }
    });
    return userStreak ? userStreak.currentStreak >= 7 : false;
  }

  private static async awardBadge(userId: string, badgeId: string): Promise<void> {
    try {
      await prisma.userBadge.create({
        data: {
          userId,
          badgeId
        }
      });
      
      console.log(`[Gamification] Badge otorgado: ${badgeId} a usuario ${userId}`);
      
      // Otorgar puntos bonus por el badge
      await this.awardPoints(userId, 50, `Badge desbloqueado: ${badgeId}`);
    } catch (error) {
      console.error(`[Gamification] Error otorgando badge ${badgeId}:`, error);
    }
  }

  // Sistema de rachas
  static async updateUserStreak(userId: string, eventType: string): Promise<void> {
    try {
      // Solo eventos que cuentan para la racha
      const streakEvents = ['add_tx', 'daily_open', 'create_budget', 'goal_contrib'];
      if (!streakEvents.includes(eventType)) return;

      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const userStreak = await prisma.userStreak.findUnique({
        where: { userId }
      });

      if (!userStreak) {
        // Crear nueva racha
        await prisma.userStreak.create({
          data: {
            userId,
            currentStreak: 1,
            longestStreak: 1,
            lastActivityDate: new Date(),
            streakType: 'daily'
          }
        });
        return;
      }

      const lastActivity = userStreak.lastActivityDate;
      const lastActivityDay = lastActivity ? new Date(lastActivity) : new Date();
      lastActivityDay.setHours(0, 0, 0, 0);

      const daysDiff = Math.floor((today.getTime() - lastActivityDay.getTime()) / (1000 * 60 * 60 * 24));

      if (daysDiff === 0) {
        // Mismo día, no actualizar racha
        return;
      } else if (daysDiff === 1) {
        // Día consecutivo, incrementar racha
        const newStreak = userStreak.currentStreak + 1;
        await prisma.userStreak.update({
          where: { userId },
          data: {
            currentStreak: newStreak,
            longestStreak: Math.max(userStreak.longestStreak, newStreak),
            lastActivityDate: new Date()
          }
        });
      } else {
        // Racha rota, reiniciar
        await prisma.userStreak.update({
          where: { userId },
          data: {
            currentStreak: 1,
            lastActivityDate: new Date()
          }
        });
        
        // Disparar evento de racha rota
        await this.dispatchEvent({
          userId,
          eventType: 'streak_break',
          eventData: { previousStreak: userStreak.currentStreak }
        });
      }
    } catch (error) {
      console.error('[Gamification] Error actualizando racha:', error);
    }
  }

  // APIs públicas
  static async getUserFinScore(userId: string): Promise<{ score: number; breakdown: FinScoreBreakdown }> {
    try {
      const latestScore = await prisma.finScoreHistory.findFirst({
        where: { userId },
        orderBy: { calculatedAt: 'desc' }
      });

      if (!latestScore) {
        const score = await this.recalculateFinScore(userId);
        const breakdown = await this.calculateFinScoreBreakdown(userId);
        return { score, breakdown };
      }

      return {
        score: latestScore.score,
        breakdown: latestScore.breakdown as any as FinScoreBreakdown
      };
    } catch (error) {
      console.error('[Gamification] Error obteniendo FinScore:', error);
      return { score: 0, breakdown: { savings: 0, budget: 0, streak: 0, debt: 0, activity: 0 } };
    }
  }

  static async getUserBadges(userId: string): Promise<any[]> {
    try {
      return await prisma.userBadge.findMany({
        where: { userId },
        orderBy: { earnedAt: 'desc' }
      });
    } catch (error) {
      console.error('[Gamification] Error obteniendo badges:', error);
      return [];
    }
  }

  static async getUserStreak(userId: string): Promise<any> {
    try {
      const streak = await prisma.userStreak.findUnique({
        where: { userId }
      });

      if (!streak) return null;

      // Calcular si la racha está activa basado en lastActivityDate
      const now = new Date();
      const lastActivity = new Date(streak.lastActivityDate || 0);
      
      // Normalizar fechas a medianoche para comparar solo días
      const nowDay = new Date(now);
      nowDay.setHours(0, 0, 0, 0);
      
      const lastActivityDay = new Date(lastActivity);
      lastActivityDay.setHours(0, 0, 0, 0);
      
      const diffTime = nowDay.getTime() - lastActivityDay.getTime();
      const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
      
      // La racha está activa SOLO si la última actividad fue HOY (diffDays === 0)
      // Si fue ayer o antes, la racha está rota porque no tuviste actividad hoy
      const isActive = diffDays === 0;
      
      // Si la racha está inactiva, el currentStreak debe ser 0
      const currentStreak = isActive ? streak.currentStreak : 0;
      
      console.log(`[Gamification] Calculando isActive para usuario ${userId}:`);
      console.log(`  - Ahora: ${now.toISOString()}`);
      console.log(`  - Última actividad: ${lastActivity.toISOString()}`);
      console.log(`  - Diferencia en días: ${diffDays}`);
      console.log(`  - isActive: ${isActive}`);
      console.log(`  - currentStreak original: ${streak.currentStreak}`);
      console.log(`  - currentStreak calculado: ${currentStreak}`);

      return {
        ...streak,
        currentStreak,
        isActive
      };
    } catch (error) {
      console.error('[Gamification] Error obteniendo racha:', error);
      return null;
    }
  }
}