import { prisma } from '../lib/prisma';
import { openai } from '../openaiClient';
import { subscriptionService } from './subscriptionService';
import { logger } from '../utils/logger';
import { Decimal } from '@prisma/client/runtime/library';

// Configuración
const MAX_REPORTS_PER_USER = 12; // Máximo 12 semanas de historial

// Interfaces
interface CategoryData {
  category: string;
  icon: string;
  amount: number;
  percentage: number;
}

interface BudgetStatus {
  name: string;
  spent: number;
  limit: number;
  percentage: number;
  isExceeded: boolean;
}

interface GoalProgress {
  name: string;
  current: number;
  target: number;
  percentage: number;
  deadline: string | null;
}

interface AntExpenseData {
  total: number;
  percentage: number;
  topItems: { category: string; amount: number; count: number }[];
}

interface Predictions {
  endOfMonthSavings: number;
  budgetWarnings: string[];
  savingsProjection: number;
}

interface VsLastWeek {
  incomeChange: number;
  expensesChange: number;
  scoreChange: number;
  savingsRateChange: number;
}

interface WeeklyReportData {
  weekStart: Date;
  weekEnd: Date;
  totalIncome: number;
  totalExpenses: number;
  savingsRate: number;
  financialScore: number;
  topCategories: CategoryData[];
  budgetsStatus: BudgetStatus[];
  goalsProgress: GoalProgress[];
  antExpenses: AntExpenseData;
  predictions: Predictions;
  aiAnalysis: string;
  recommendations: string[];
  vsLastWeek: VsLastWeek | null;
}

export class WeeklyReportService {
  /**
   * Genera el reporte semanal para un usuario PRO
   */
  static async generateWeeklyReport(userId: string): Promise<{
    success: boolean;
    report?: any;
    reason?: string;
  }> {
    try {
      logger.log(`[WeeklyReport] Generando reporte para usuario ${userId}`);

      // 1. Verificar que es usuario PRO
      const subscription = await subscriptionService.getUserSubscription(userId);
      if (subscription.plan !== 'PRO') {
        return { success: false, reason: 'Usuario no es PRO' };
      }

      // 2. Obtener usuario
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { name: true, currency: true }
      });

      if (!user) {
        return { success: false, reason: 'Usuario no encontrado' };
      }

      // 3. Calcular fechas de la semana anterior (lunes a domingo)
      const { weekStart, weekEnd } = this.getLastWeekDates();

      // 4. Verificar si ya existe reporte para esta semana
      const existingReport = await prisma.weeklyReport.findUnique({
        where: {
          userId_weekStart: {
            userId,
            weekStart
          }
        }
      });

      if (existingReport) {
        return {
          success: true,
          report: existingReport,
          reason: 'Reporte ya existente'
        };
      }

      // 5. Recopilar datos financieros
      const reportData = await this.gatherWeeklyData(userId, weekStart, weekEnd, user.currency);

      // 6. Generar análisis con IA
      const aiResult = await this.generateAIAnalysis(reportData, user.name, user.currency);

      // 7. Crear el reporte en la base de datos
      const report = await prisma.weeklyReport.create({
        data: {
          userId,
          weekStart,
          weekEnd,
          totalIncome: new Decimal(reportData.totalIncome),
          totalExpenses: new Decimal(reportData.totalExpenses),
          savingsRate: reportData.savingsRate,
          financialScore: reportData.financialScore,
          topCategories: reportData.topCategories,
          budgetsStatus: reportData.budgetsStatus,
          goalsProgress: reportData.goalsProgress,
          antExpenses: reportData.antExpenses,
          predictions: reportData.predictions,
          aiAnalysis: aiResult.analysis,
          recommendations: aiResult.recommendations,
          vsLastWeek: reportData.vsLastWeek
        }
      });

      // 8. Limpiar reportes antiguos (mantener solo los últimos 12)
      await this.cleanOldReports(userId);

      logger.log(`[WeeklyReport] Reporte generado exitosamente para ${userId}`);

      return { success: true, report };

    } catch (error: any) {
      logger.error(`[WeeklyReport] Error generando reporte para ${userId}:`, error);
      return { success: false, reason: error.message };
    }
  }

  /**
   * Obtiene las fechas de la semana anterior (lunes a domingo)
   */
  static getLastWeekDates(): { weekStart: Date; weekEnd: Date } {
    const now = new Date();
    const dayOfWeek = now.getDay();

    // Calcular el domingo de la semana pasada
    const sundayOffset = dayOfWeek === 0 ? 7 : dayOfWeek;
    const weekEnd = new Date(now);
    weekEnd.setDate(now.getDate() - sundayOffset);
    weekEnd.setHours(23, 59, 59, 999);

    // Calcular el lunes de la semana pasada
    const weekStart = new Date(weekEnd);
    weekStart.setDate(weekEnd.getDate() - 6);
    weekStart.setHours(0, 0, 0, 0);

    return { weekStart, weekEnd };
  }

  /**
   * Recopila todos los datos financieros de la semana
   */
  private static async gatherWeeklyData(
    userId: string,
    weekStart: Date,
    weekEnd: Date,
    currency: string
  ): Promise<WeeklyReportData> {
    // Transacciones de la semana
    const transactions = await prisma.transaction.findMany({
      where: {
        userId,
        date: { gte: weekStart, lte: weekEnd }
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

    // Tasa de ahorro
    const savingsRate = totalIncome > 0
      ? Math.round(((totalIncome - totalExpenses) / totalIncome) * 100)
      : 0;

    // Top categorías de gasto
    const expensesByCategory = new Map<string, { amount: number; icon: string }>();
    transactions
      .filter(t => t.type === 'EXPENSE')
      .forEach(t => {
        const catName = t.category?.name || 'Otros';
        const catIcon = t.category?.icon || '📦';
        const current = expensesByCategory.get(catName) || { amount: 0, icon: catIcon };
        expensesByCategory.set(catName, {
          amount: current.amount + Number(t.amount),
          icon: catIcon
        });
      });

    const topCategories: CategoryData[] = Array.from(expensesByCategory.entries())
      .map(([category, data]) => ({
        category,
        icon: data.icon,
        amount: Math.round(data.amount * 100) / 100,
        percentage: totalExpenses > 0 ? Math.round((data.amount / totalExpenses) * 100) : 0
      }))
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 5);

    // Estado de presupuestos activos
    const budgets = await prisma.budget.findMany({
      where: {
        user_id: userId,
        is_active: true,
        start_date: { lte: weekEnd },
        end_date: { gte: weekStart }
      }
    });

    const budgetsStatus: BudgetStatus[] = budgets.map(b => {
      const spent = Number(b.spent) || 0;
      const limit = Number(b.amount);
      const percentage = limit > 0 ? Math.round((spent / limit) * 100) : 0;
      return {
        name: b.name,
        spent: Math.round(spent * 100) / 100,
        limit: Math.round(limit * 100) / 100,
        percentage,
        isExceeded: spent > limit
      };
    });

    // Progreso de metas
    const goals = await prisma.goal.findMany({
      where: {
        userId,
        isActive: true,
        isCompleted: false
      }
    });

    const goalsProgress: GoalProgress[] = goals.map(g => ({
      name: g.name,
      current: Math.round(Number(g.currentAmount) * 100) / 100,
      target: Math.round(Number(g.targetAmount) * 100) / 100,
      percentage: Number(g.targetAmount) > 0
        ? Math.round((Number(g.currentAmount) / Number(g.targetAmount)) * 100)
        : 0,
      deadline: g.deadline ? g.deadline.toISOString().split('T')[0] : null
    }));

    // Gastos hormiga (transacciones <= 500)
    const antThreshold = 500;
    const antExpensesList = transactions
      .filter(t => t.type === 'EXPENSE' && Number(t.amount) <= antThreshold);

    const antTotal = antExpensesList.reduce((sum, t) => sum + Number(t.amount), 0);
    const antPercentage = totalExpenses > 0 ? Math.round((antTotal / totalExpenses) * 100) : 0;

    // Top items de gastos hormiga
    const antByCategory = new Map<string, { amount: number; count: number }>();
    antExpensesList.forEach(t => {
      const catName = t.category?.name || 'Otros';
      const current = antByCategory.get(catName) || { amount: 0, count: 0 };
      antByCategory.set(catName, {
        amount: current.amount + Number(t.amount),
        count: current.count + 1
      });
    });

    const antExpenses: AntExpenseData = {
      total: Math.round(antTotal * 100) / 100,
      percentage: antPercentage,
      topItems: Array.from(antByCategory.entries())
        .map(([category, data]) => ({ category, amount: data.amount, count: data.count }))
        .sort((a, b) => b.amount - a.amount)
        .slice(0, 3)
    };

    // Predicciones
    const predictions = await this.calculatePredictions(userId, totalIncome, totalExpenses, budgetsStatus, currency);

    // Calcular score financiero
    const financialScore = this.calculateFinancialScore(savingsRate, budgetsStatus, goalsProgress, antPercentage);

    // Comparación con semana anterior
    const vsLastWeek = await this.getLastWeekComparison(userId, weekStart, totalIncome, totalExpenses, savingsRate, financialScore);

    return {
      weekStart,
      weekEnd,
      totalIncome: Math.round(totalIncome * 100) / 100,
      totalExpenses: Math.round(totalExpenses * 100) / 100,
      savingsRate,
      financialScore,
      topCategories,
      budgetsStatus,
      goalsProgress,
      antExpenses,
      predictions,
      aiAnalysis: '', // Se llenará con IA
      recommendations: [], // Se llenará con IA
      vsLastWeek
    };
  }

  /**
   * Calcula predicciones financieras
   */
  private static async calculatePredictions(
    userId: string,
    weeklyIncome: number,
    weeklyExpenses: number,
    budgets: BudgetStatus[],
    currency: string
  ): Promise<Predictions> {
    // Proyección de ahorro a fin de mes (asumiendo 4 semanas)
    const now = new Date();
    const daysLeftInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate() - now.getDate();
    const weeksLeft = Math.ceil(daysLeftInMonth / 7);

    const projectedMonthlyIncome = weeklyIncome * 4;
    const projectedMonthlyExpenses = weeklyExpenses * 4;
    const endOfMonthSavings = Math.round((projectedMonthlyIncome - projectedMonthlyExpenses) * 100) / 100;

    // Advertencias de presupuesto
    const budgetWarnings: string[] = [];
    budgets.forEach(b => {
      if (b.percentage >= 90 && !b.isExceeded) {
        budgetWarnings.push(`${b.name} está al ${b.percentage}%, considera reducir gastos`);
      } else if (b.isExceeded) {
        budgetWarnings.push(`${b.name} excedido por ${currency}${(b.spent - b.limit).toFixed(2)}`);
      }
    });

    // Proyección de ahorros anual (si mantiene el ritmo actual)
    const savingsProjection = Math.round((projectedMonthlyIncome - projectedMonthlyExpenses) * 12);

    return {
      endOfMonthSavings,
      budgetWarnings,
      savingsProjection
    };
  }

  /**
   * Calcula el score financiero (0-100)
   */
  private static calculateFinancialScore(
    savingsRate: number,
    budgets: BudgetStatus[],
    goals: GoalProgress[],
    antPercentage: number
  ): number {
    let score = 50; // Base

    // Tasa de ahorro (+30 puntos max)
    if (savingsRate >= 20) score += 30;
    else if (savingsRate >= 10) score += 20;
    else if (savingsRate >= 0) score += 10;
    else score -= 10; // Negativo si gasta más de lo que gana

    // Control de presupuestos (+20 puntos max)
    if (budgets.length > 0) {
      const avgBudgetUsage = budgets.reduce((sum, b) => sum + b.percentage, 0) / budgets.length;
      const exceededCount = budgets.filter(b => b.isExceeded).length;

      if (exceededCount === 0 && avgBudgetUsage <= 80) score += 20;
      else if (exceededCount <= 1 && avgBudgetUsage <= 90) score += 10;
      else if (exceededCount > budgets.length / 2) score -= 10;
    }

    // Progreso en metas (+15 puntos max)
    if (goals.length > 0) {
      const avgProgress = goals.reduce((sum, g) => sum + g.percentage, 0) / goals.length;
      if (avgProgress >= 50) score += 15;
      else if (avgProgress >= 25) score += 10;
      else score += 5;
    }

    // Control de gastos hormiga (+15 puntos max)
    if (antPercentage <= 10) score += 15;
    else if (antPercentage <= 20) score += 10;
    else if (antPercentage <= 30) score += 5;
    else score -= 5;

    // Asegurar que esté en rango 0-100
    return Math.max(0, Math.min(100, score));
  }

  /**
   * Compara con la semana anterior
   */
  private static async getLastWeekComparison(
    userId: string,
    currentWeekStart: Date,
    currentIncome: number,
    currentExpenses: number,
    currentSavingsRate: number,
    currentScore: number
  ): Promise<VsLastWeek | null> {
    // Buscar reporte de la semana anterior
    const previousWeekStart = new Date(currentWeekStart);
    previousWeekStart.setDate(previousWeekStart.getDate() - 7);

    const previousReport = await prisma.weeklyReport.findUnique({
      where: {
        userId_weekStart: {
          userId,
          weekStart: previousWeekStart
        }
      }
    });

    if (!previousReport) {
      return null;
    }

    const prevIncome = Number(previousReport.totalIncome);
    const prevExpenses = Number(previousReport.totalExpenses);
    const prevSavingsRate = previousReport.savingsRate;
    const prevScore = previousReport.financialScore;

    return {
      incomeChange: prevIncome > 0
        ? Math.round(((currentIncome - prevIncome) / prevIncome) * 100)
        : 0,
      expensesChange: prevExpenses > 0
        ? Math.round(((currentExpenses - prevExpenses) / prevExpenses) * 100)
        : 0,
      scoreChange: currentScore - prevScore,
      savingsRateChange: currentSavingsRate - prevSavingsRate
    };
  }

  /**
   * Genera análisis con IA
   */
  private static async generateAIAnalysis(
    data: WeeklyReportData,
    userName: string,
    currency: string
  ): Promise<{ analysis: string; recommendations: string[] }> {
    try {
      const prompt = this.buildAIPrompt(data, userName, currency);

      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `Eres Zenio, el asistente financiero de FinZen AI. Genera un análisis semanal personalizado.

FORMATO DE RESPUESTA (JSON):
{
  "analysis": "Análisis en 2-3 párrafos cortos, máximo 200 palabras. Sé específico con los datos. Usa un tono amigable y directo. Tutea al usuario.",
  "recommendations": ["Recomendación 1 específica y accionable", "Recomendación 2", "Recomendación 3"]
}

REGLAS:
- Menciona logros positivos primero
- Sé específico con montos y porcentajes
- Las recomendaciones deben ser ACCIONABLES (algo que pueda hacer esta semana)
- Máximo 3 recomendaciones
- Usa emojis con moderación (1-2 por párrafo)`
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.7,
        max_tokens: 500
      });

      const content = response.choices[0]?.message?.content?.trim();

      if (!content) {
        throw new Error('Respuesta vacía de OpenAI');
      }

      // Parsear JSON
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No se encontró JSON en respuesta');
      }

      const result = JSON.parse(jsonMatch[0]);

      return {
        analysis: result.analysis || 'No se pudo generar el análisis.',
        recommendations: result.recommendations || []
      };

    } catch (error: any) {
      logger.error('[WeeklyReport] Error generando análisis IA:', error);

      // Análisis por defecto si falla la IA
      return {
        analysis: `Esta semana tuviste ingresos de ${currency}${data.totalIncome.toLocaleString()} y gastos de ${currency}${data.totalExpenses.toLocaleString()}. Tu tasa de ahorro fue del ${data.savingsRate}%.`,
        recommendations: [
          'Revisa tus gastos más grandes esta semana',
          'Considera establecer un presupuesto si no lo tienes',
          'Intenta ahorrar al menos un 20% de tus ingresos'
        ]
      };
    }
  }

  /**
   * Construye el prompt para la IA
   */
  private static buildAIPrompt(data: WeeklyReportData, userName: string, currency: string): string {
    const parts: string[] = [];

    parts.push(`REPORTE SEMANAL DE ${userName.toUpperCase()}`);
    parts.push(`Período: ${data.weekStart.toLocaleDateString('es-DO')} - ${data.weekEnd.toLocaleDateString('es-DO')}`);
    parts.push('');

    // Resumen financiero
    parts.push('RESUMEN:');
    parts.push(`- Ingresos: ${currency}${data.totalIncome.toLocaleString()}`);
    parts.push(`- Gastos: ${currency}${data.totalExpenses.toLocaleString()}`);
    parts.push(`- Ahorro: ${currency}${(data.totalIncome - data.totalExpenses).toLocaleString()} (${data.savingsRate}%)`);
    parts.push(`- Score financiero: ${data.financialScore}/100`);
    parts.push('');

    // Comparación con semana anterior
    if (data.vsLastWeek) {
      parts.push('VS SEMANA ANTERIOR:');
      parts.push(`- Ingresos: ${data.vsLastWeek.incomeChange >= 0 ? '+' : ''}${data.vsLastWeek.incomeChange}%`);
      parts.push(`- Gastos: ${data.vsLastWeek.expensesChange >= 0 ? '+' : ''}${data.vsLastWeek.expensesChange}%`);
      parts.push(`- Score: ${data.vsLastWeek.scoreChange >= 0 ? '+' : ''}${data.vsLastWeek.scoreChange} puntos`);
      parts.push('');
    }

    // Top categorías
    if (data.topCategories.length > 0) {
      parts.push('TOP GASTOS:');
      data.topCategories.forEach((cat, i) => {
        parts.push(`${i + 1}. ${cat.category}: ${currency}${cat.amount.toLocaleString()} (${cat.percentage}%)`);
      });
      parts.push('');
    }

    // Presupuestos
    if (data.budgetsStatus.length > 0) {
      parts.push('PRESUPUESTOS:');
      data.budgetsStatus.forEach(b => {
        const status = b.isExceeded ? '🔴 EXCEDIDO' : b.percentage >= 80 ? '🟡 CERCA' : '🟢 OK';
        parts.push(`- ${b.name}: ${b.percentage}% (${currency}${b.spent}/${currency}${b.limit}) ${status}`);
      });
      parts.push('');
    }

    // Metas
    if (data.goalsProgress.length > 0) {
      parts.push('METAS:');
      data.goalsProgress.forEach(g => {
        parts.push(`- ${g.name}: ${g.percentage}% (${currency}${g.current}/${currency}${g.target})`);
      });
      parts.push('');
    }

    // Gastos hormiga
    if (data.antExpenses.total > 0) {
      parts.push(`GASTOS HORMIGA: ${currency}${data.antExpenses.total.toLocaleString()} (${data.antExpenses.percentage}% del total)`);
      if (data.antExpenses.topItems.length > 0) {
        parts.push(`Principal categoría: ${data.antExpenses.topItems[0].category} (${data.antExpenses.topItems[0].count} compras)`);
      }
      parts.push('');
    }

    // Predicciones
    if (data.predictions.budgetWarnings.length > 0) {
      parts.push('ALERTAS:');
      data.predictions.budgetWarnings.forEach(w => parts.push(`⚠️ ${w}`));
      parts.push('');
    }

    parts.push(`Proyección de ahorro mensual: ${currency}${data.predictions.endOfMonthSavings.toLocaleString()}`);

    return parts.join('\n');
  }

  /**
   * Limpia reportes antiguos (mantiene solo los últimos 12)
   */
  private static async cleanOldReports(userId: string): Promise<void> {
    const reports = await prisma.weeklyReport.findMany({
      where: { userId },
      orderBy: { weekStart: 'desc' },
      select: { id: true }
    });

    if (reports.length > MAX_REPORTS_PER_USER) {
      const reportsToDelete = reports.slice(MAX_REPORTS_PER_USER);
      await prisma.weeklyReport.deleteMany({
        where: {
          id: { in: reportsToDelete.map(r => r.id) }
        }
      });
      logger.log(`[WeeklyReport] Eliminados ${reportsToDelete.length} reportes antiguos para ${userId}`);
    }
  }

  /**
   * Obtiene el historial de reportes de un usuario
   */
  static async getReportHistory(userId: string): Promise<any[]> {
    const reports = await prisma.weeklyReport.findMany({
      where: { userId },
      orderBy: { weekStart: 'desc' },
      select: {
        id: true,
        weekStart: true,
        weekEnd: true,
        totalIncome: true,
        totalExpenses: true,
        savingsRate: true,
        financialScore: true,
        viewedAt: true,
        createdAt: true
      }
    });

    return reports.map(r => ({
      ...r,
      totalIncome: Number(r.totalIncome),
      totalExpenses: Number(r.totalExpenses),
      isNew: r.viewedAt === null
    }));
  }

  /**
   * Obtiene un reporte específico por ID
   */
  static async getReportById(reportId: string, userId: string): Promise<any | null> {
    const report = await prisma.weeklyReport.findFirst({
      where: { id: reportId, userId }
    });

    if (!report) {
      return null;
    }

    return {
      ...report,
      totalIncome: Number(report.totalIncome),
      totalExpenses: Number(report.totalExpenses)
    };
  }

  /**
   * Marca un reporte como visto
   */
  static async markReportAsViewed(reportId: string, userId: string): Promise<boolean> {
    try {
      await prisma.weeklyReport.updateMany({
        where: { id: reportId, userId },
        data: { viewedAt: new Date() }
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Obtiene el conteo de reportes no vistos
   */
  static async getUnviewedCount(userId: string): Promise<number> {
    return prisma.weeklyReport.count({
      where: { userId, viewedAt: null }
    });
  }

  /**
   * Marca la notificación como enviada
   */
  static async markReportNotified(reportId: string): Promise<void> {
    await prisma.weeklyReport.update({
      where: { id: reportId },
      data: { notifiedAt: new Date() }
    });
  }
}

export default WeeklyReportService;
