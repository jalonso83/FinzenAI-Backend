import { prisma } from '../lib/prisma';
import { openai } from '../openaiClient';
import { NotificationService } from './notificationService';
import { subscriptionService } from './subscriptionService';
import crypto from 'crypto';

import { logger } from '../utils/logger';

// Configuración
const TIP_COOLDOWN_HOURS = 72; // No enviar otro tip si recibió uno en las últimas 72 horas
const MAX_TIPS_PER_WEEK = 2;

export interface UserFinancialContext {
  userId: string;
  userName: string;
  currency: string;
  // Resumen financiero
  totalIncome: number;
  totalExpenses: number;
  savingsRate: number;
  // Top categorías de gasto
  topExpenseCategories: { category: string; amount: number; percentage: number }[];
  // Estado de presupuestos
  budgets: { name: string; spent: number; limit: number; percentage: number }[];
  exceededBudgets: string[];
  // Estado de metas
  goals: { name: string; current: number; target: number; percentage: number; daysSinceContribution: number | null }[];
  stagnantGoals: string[];
  // Gastos hormiga
  antExpenseTotal: number;
  antExpensePercentage: number;
  // Contexto temporal
  currentMonth: string;
  dayOfMonth: number;
  isEndOfMonth: boolean;
  isStartOfMonth: boolean;
}

export interface GeneratedTip {
  title: string;
  content: string;
  category: string;
}

export class TipEngineService {
  /**
   * Genera y envía un tip personalizado a un usuario
   */
  static async generateAndSendTip(userId: string): Promise<{
    sent: boolean;
    reason: string;
    tip?: GeneratedTip;
  }> {
    try {
      // 1. Verificar que es usuario PRO
      const subscription = await subscriptionService.getUserSubscription(userId);
      if (subscription.plan !== 'PRO') {
        return { sent: false, reason: 'Usuario no es PRO' };
      }

      // 2. Verificar preferencias de notificación
      const preferences = await prisma.notificationPreferences.findUnique({
        where: { userId }
      });

      if (!preferences?.tipsEnabled) {
        return { sent: false, reason: 'Tips deshabilitados por el usuario' };
      }

      // 3. Verificar cooldown (no enviar si recibió tip recientemente)
      const recentTip = await prisma.userTipHistory.findFirst({
        where: {
          userId,
          sentAt: {
            gte: new Date(Date.now() - TIP_COOLDOWN_HOURS * 60 * 60 * 1000)
          }
        },
        orderBy: { sentAt: 'desc' }
      });

      if (recentTip) {
        const hoursAgo = Math.round((Date.now() - recentTip.sentAt.getTime()) / (1000 * 60 * 60));
        return { sent: false, reason: `Ya recibió tip hace ${hoursAgo} horas` };
      }

      // 4. Verificar límite semanal
      const startOfWeek = new Date();
      startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());
      startOfWeek.setHours(0, 0, 0, 0);

      const tipsThisWeek = await prisma.userTipHistory.count({
        where: {
          userId,
          sentAt: { gte: startOfWeek }
        }
      });

      if (tipsThisWeek >= MAX_TIPS_PER_WEEK) {
        return { sent: false, reason: `Ya recibió ${tipsThisWeek} tips esta semana (máx: ${MAX_TIPS_PER_WEEK})` };
      }

      // 5. Recopilar contexto financiero del usuario
      const context = await this.gatherUserContext(userId);

      // 6. Generar tip con IA
      const tip = await this.generateTipWithAI(context);

      if (!tip) {
        return { sent: false, reason: 'No se pudo generar el tip' };
      }

      // 7. Verificar que no sea un tip repetido (hash del contenido)
      const tipHash = this.hashTip(tip.content);
      const duplicateTip = await prisma.userTipHistory.findFirst({
        where: {
          userId,
          tipHash,
          sentAt: {
            gte: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000) // 60 días
          }
        }
      });

      if (duplicateTip) {
        return { sent: false, reason: 'Tip duplicado detectado, regenerando...' };
      }

      // 8. Enviar notificación
      const result = await NotificationService.notifyTip(userId, tip.title, tip.content);

      if (!result.success && result.successCount === 0) {
        return { sent: false, reason: 'Error enviando notificación' };
      }

      // 9. Guardar en historial
      await prisma.userTipHistory.create({
        data: {
          userId,
          tipHash,
          title: tip.title,
          content: tip.content,
          category: tip.category
        }
      });

      logger.log(`[TipEngine] ✅ Tip enviado a usuario ${userId}: "${tip.title}"`);

      return {
        sent: true,
        reason: 'Tip enviado exitosamente',
        tip
      };

    } catch (error: any) {
      logger.error(`[TipEngine] Error generando tip para usuario ${userId}:`, error);
      return { sent: false, reason: `Error: ${error.message}` };
    }
  }

  /**
   * Recopila el contexto financiero del usuario
   */
  private static async gatherUserContext(userId: string): Promise<UserFinancialContext> {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);

    // Obtener usuario
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, currency: true }
    });

    // Transacciones del mes
    const transactions = await prisma.transaction.findMany({
      where: {
        userId,
        date: { gte: startOfMonth, lte: now }
      },
      include: { category: true }
    });

    // Calcular ingresos y gastos
    const totalIncome = transactions
      .filter(t => t.type === 'INCOME')
      .reduce((sum, t) => sum + Number(t.amount), 0);

    const totalExpenses = transactions
      .filter(t => t.type === 'EXPENSE')
      .reduce((sum, t) => sum + Number(t.amount), 0);

    const savingsRate = totalIncome > 0 ? ((totalIncome - totalExpenses) / totalIncome) * 100 : 0;

    // Top categorías de gasto
    const expensesByCategory = new Map<string, number>();
    transactions
      .filter(t => t.type === 'EXPENSE')
      .forEach(t => {
        const catName = t.category?.name || 'Otros';
        expensesByCategory.set(catName, (expensesByCategory.get(catName) || 0) + Number(t.amount));
      });

    const topExpenseCategories = Array.from(expensesByCategory.entries())
      .map(([category, amount]) => ({
        category,
        amount,
        percentage: totalExpenses > 0 ? (amount / totalExpenses) * 100 : 0
      }))
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 5);

    // Presupuestos activos
    const budgets = await prisma.budget.findMany({
      where: {
        user_id: userId,
        is_active: true,
        start_date: { lte: now },
        end_date: { gte: now }
      }
    });

    const budgetStatus = budgets.map(b => ({
      name: b.name,
      spent: Number(b.spent) || 0,
      limit: Number(b.amount),
      percentage: Number(b.amount) > 0 ? ((Number(b.spent) || 0) / Number(b.amount)) * 100 : 0
    }));

    const exceededBudgets = budgetStatus
      .filter(b => b.percentage >= 100)
      .map(b => b.name);

    // Metas activas
    const goals = await prisma.goal.findMany({
      where: {
        userId,
        isActive: true,
        isCompleted: false
      }
    });

    const goalStatus = goals.map(g => {
      const daysSinceContribution = g.lastContributionDate
        ? Math.floor((now.getTime() - g.lastContributionDate.getTime()) / (1000 * 60 * 60 * 24))
        : null;

      return {
        name: g.name,
        current: Number(g.currentAmount),
        target: Number(g.targetAmount),
        percentage: Number(g.targetAmount) > 0 ? (Number(g.currentAmount) / Number(g.targetAmount)) * 100 : 0,
        daysSinceContribution
      };
    });

    const stagnantGoals = goalStatus
      .filter(g => g.daysSinceContribution !== null && g.daysSinceContribution >= 14)
      .map(g => g.name);

    // Gastos hormiga (transacciones pequeñas < 500 en moneda local)
    const antExpenseThreshold = 500;
    const antExpenses = transactions
      .filter(t => t.type === 'EXPENSE' && Number(t.amount) <= antExpenseThreshold)
      .reduce((sum, t) => sum + Number(t.amount), 0);

    const antExpensePercentage = totalExpenses > 0 ? (antExpenses / totalExpenses) * 100 : 0;

    // Contexto temporal
    const months = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
      'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

    return {
      userId,
      userName: user?.name || 'Usuario',
      currency: user?.currency || 'RD$',
      totalIncome,
      totalExpenses,
      savingsRate,
      topExpenseCategories,
      budgets: budgetStatus,
      exceededBudgets,
      goals: goalStatus,
      stagnantGoals,
      antExpenseTotal: antExpenses,
      antExpensePercentage,
      currentMonth: months[now.getMonth()],
      dayOfMonth: now.getDate(),
      isEndOfMonth: now.getDate() >= 25,
      isStartOfMonth: now.getDate() <= 5
    };
  }

  /**
   * Genera un tip usando IA
   */
  private static async generateTipWithAI(context: UserFinancialContext): Promise<GeneratedTip | null> {
    try {
      const prompt = this.buildPrompt(context);

      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `Eres Zenio, un asistente financiero amigable y directo. Tu tarea es generar UN solo tip financiero personalizado basado en los datos del usuario.

REGLAS:
- Máximo 2 oraciones
- Sé específico usando los datos proporcionados (montos, nombres de metas, categorías)
- Tono amigable pero directo, tutea al usuario
- El tip debe ser ACCIONABLE (algo que pueda hacer hoy)
- Usa emojis con moderación (máximo 1)
- Responde SOLO en formato JSON: {"title": "...", "content": "...", "category": "..."}`
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.8,
        max_tokens: 200
      });

      const content = response.choices[0]?.message?.content?.trim();

      if (!content) {
        logger.error('[TipEngine] Respuesta vacía de OpenAI');
        return null;
      }

      // Parsear JSON de la respuesta
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        logger.error('[TipEngine] No se encontró JSON en respuesta:', content);
        return null;
      }

      const tip = JSON.parse(jsonMatch[0]) as GeneratedTip;

      // Validar estructura
      if (!tip.title || !tip.content || !tip.category) {
        logger.error('[TipEngine] Tip incompleto:', tip);
        return null;
      }

      return tip;

    } catch (error: any) {
      logger.error('[TipEngine] Error llamando a OpenAI:', error);
      return null;
    }
  }

  /**
   * Construye el prompt para la IA
   */
  private static buildPrompt(ctx: UserFinancialContext): string {
    const parts: string[] = [];

    parts.push(`DATOS DE ${ctx.userName.toUpperCase()}:`);
    parts.push(`- Moneda: ${ctx.currency}`);
    parts.push(`- Mes actual: ${ctx.currentMonth} (día ${ctx.dayOfMonth})`);
    parts.push('');

    // Resumen financiero
    parts.push('RESUMEN DEL MES:');
    parts.push(`- Ingresos: ${ctx.currency}${ctx.totalIncome.toLocaleString()}`);
    parts.push(`- Gastos: ${ctx.currency}${ctx.totalExpenses.toLocaleString()}`);
    parts.push(`- Tasa de ahorro: ${ctx.savingsRate.toFixed(1)}%`);
    parts.push('');

    // Top gastos
    if (ctx.topExpenseCategories.length > 0) {
      parts.push('TOP CATEGORÍAS DE GASTO:');
      ctx.topExpenseCategories.slice(0, 3).forEach((cat, i) => {
        parts.push(`${i + 1}. ${cat.category}: ${ctx.currency}${cat.amount.toLocaleString()} (${cat.percentage.toFixed(1)}%)`);
      });
      parts.push('');
    }

    // Presupuestos
    if (ctx.budgets.length > 0) {
      parts.push('PRESUPUESTOS:');
      ctx.budgets.forEach(b => {
        const status = b.percentage >= 100 ? '🔴 EXCEDIDO' : b.percentage >= 80 ? '🟡 CERCA' : '🟢 OK';
        parts.push(`- ${b.name}: ${b.percentage.toFixed(0)}% usado (${ctx.currency}${b.spent.toLocaleString()}/${ctx.currency}${b.limit.toLocaleString()}) ${status}`);
      });
      parts.push('');
    }

    // Metas
    if (ctx.goals.length > 0) {
      parts.push('METAS:');
      ctx.goals.forEach(g => {
        const stagnant = g.daysSinceContribution !== null && g.daysSinceContribution >= 7
          ? ` (⚠️ ${g.daysSinceContribution} días sin aportar)`
          : '';
        parts.push(`- ${g.name}: ${g.percentage.toFixed(0)}% (${ctx.currency}${g.current.toLocaleString()}/${ctx.currency}${g.target.toLocaleString()})${stagnant}`);
      });
      parts.push('');
    }

    // Gastos hormiga
    if (ctx.antExpensePercentage > 15) {
      parts.push(`GASTOS HORMIGA: ${ctx.currency}${ctx.antExpenseTotal.toLocaleString()} (${ctx.antExpensePercentage.toFixed(1)}% del gasto total)`);
      parts.push('');
    }

    // Contexto especial
    const specialContext: string[] = [];
    if (ctx.isEndOfMonth) specialContext.push('Es fin de mes');
    if (ctx.isStartOfMonth) specialContext.push('Es inicio de mes');
    if (ctx.exceededBudgets.length > 0) specialContext.push(`Presupuestos excedidos: ${ctx.exceededBudgets.join(', ')}`);
    if (ctx.stagnantGoals.length > 0) specialContext.push(`Metas estancadas: ${ctx.stagnantGoals.join(', ')}`);
    if (ctx.currentMonth === 'Diciembre') specialContext.push('Temporada navideña');
    if (ctx.currentMonth === 'Enero') specialContext.push('Año nuevo, buen momento para metas');

    if (specialContext.length > 0) {
      parts.push('CONTEXTO ESPECIAL:');
      specialContext.forEach(c => parts.push(`- ${c}`));
      parts.push('');
    }

    parts.push('Genera UN tip financiero personalizado basado en estos datos.');

    return parts.join('\n');
  }

  /**
   * Genera hash de un tip para detectar duplicados
   */
  private static hashTip(content: string): string {
    // Normalizar contenido (quitar números y espacios extra)
    const normalized = content.toLowerCase().replace(/\d+/g, 'X').replace(/\s+/g, ' ').trim();
    return crypto.createHash('md5').update(normalized).digest('hex').substring(0, 16);
  }

  /**
   * Método para testing manual
   */
  static async testForUser(userId: string): Promise<{
    context: UserFinancialContext;
    tip: GeneratedTip | null;
    prompt: string;
  }> {
    const context = await this.gatherUserContext(userId);
    const prompt = this.buildPrompt(context);
    const tip = await this.generateTipWithAI(context);

    return { context, tip, prompt };
  }
}
