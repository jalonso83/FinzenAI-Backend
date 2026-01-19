import { prisma } from '../lib/prisma';
import { openai } from '../openaiClient';
import { subscriptionService } from './subscriptionService';
import { logger } from '../utils/logger';
import { Decimal } from '@prisma/client/runtime/library';
import { DEFAULT_ANT_EXPENSE_CONFIG } from '../types/antExpense';

// Configuración
const MAX_REPORTS_PER_USER = 12; // Máximo 12 quincenas de historial (6 meses)

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
  endOfMonthBalance: number;
  projectedExpenses: number;
  budgetWarnings: string[];
  savingsProjection: number;
  monthlyTrend: string;
}

interface VsLastPeriod {
  incomeChange: number;
  expensesChange: number;
  scoreChange: number;
  savingsRateChange: number;
}

interface BiweeklyReportData {
  periodStart: Date;
  periodEnd: Date;
  periodType: 'FIRST_HALF' | 'SECOND_HALF'; // 1-15 o 16-fin de mes
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
  vsLastPeriod: VsLastPeriod | null;
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
          topCategories: JSON.parse(JSON.stringify(reportData.topCategories)),
          budgetsStatus: JSON.parse(JSON.stringify(reportData.budgetsStatus)),
          goalsProgress: JSON.parse(JSON.stringify(reportData.goalsProgress)),
          antExpenses: JSON.parse(JSON.stringify(reportData.antExpenses)),
          predictions: JSON.parse(JSON.stringify(reportData.predictions)),
          aiAnalysis: aiResult.analysis,
          recommendations: JSON.parse(JSON.stringify(aiResult.recommendations)),
          vsLastWeek: reportData.vsLastWeek ? JSON.parse(JSON.stringify(reportData.vsLastWeek)) : null
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
   * Obtiene las fechas de la quincena anterior
   * Primera quincena: 1-15 del mes
   * Segunda quincena: 16-fin del mes
   */
  static getLastBiweeklyDates(): {
    periodStart: Date;
    periodEnd: Date;
    periodType: 'FIRST_HALF' | 'SECOND_HALF'
  } {
    const now = new Date();
    const currentDay = now.getDate();
    const currentMonth = now.getMonth();
    const currentYear = now.getFullYear();

    let periodStart: Date;
    let periodEnd: Date;
    let periodType: 'FIRST_HALF' | 'SECOND_HALF';

    if (currentDay <= 15) {
      // Estamos en la primera quincena, reportar la segunda quincena del mes anterior
      const lastMonth = currentMonth === 0 ? 11 : currentMonth - 1;
      const lastMonthYear = currentMonth === 0 ? currentYear - 1 : currentYear;
      const lastDayOfLastMonth = new Date(lastMonthYear, lastMonth + 1, 0).getDate();

      periodStart = new Date(lastMonthYear, lastMonth, 16, 0, 0, 0, 0);
      periodEnd = new Date(lastMonthYear, lastMonth, lastDayOfLastMonth, 23, 59, 59, 999);
      periodType = 'SECOND_HALF';
    } else {
      // Estamos en la segunda quincena, reportar la primera quincena del mes actual
      periodStart = new Date(currentYear, currentMonth, 1, 0, 0, 0, 0);
      periodEnd = new Date(currentYear, currentMonth, 15, 23, 59, 59, 999);
      periodType = 'FIRST_HALF';
    }

    return { periodStart, periodEnd, periodType };
  }

  /**
   * Alias para compatibilidad - usa getLastBiweeklyDates internamente
   */
  static getLastWeekDates(): { weekStart: Date; weekEnd: Date } {
    const { periodStart, periodEnd } = this.getLastBiweeklyDates();
    return { weekStart: periodStart, weekEnd: periodEnd };
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
      deadline: g.targetDate ? g.targetDate.toISOString().split('T')[0] : null
    }));

    // Gastos hormiga (usa el umbral por defecto de la configuración)
    const antThreshold = DEFAULT_ANT_EXPENSE_CONFIG.antThreshold;
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

    // Predicciones con proyección a fin de mes
    const predictions = await this.calculatePredictions(
      userId,
      totalIncome,
      totalExpenses,
      budgetsStatus,
      currency,
      'FIRST_HALF' // TODO: pasar el periodType real
    );

    // Calcular score financiero con la nueva fórmula
    const hasIncome = totalIncome > 0;
    const financialScore = this.calculateFinancialScore(
      savingsRate,
      budgetsStatus,
      goalsProgress,
      antPercentage,
      hasIncome
    );

    // Comparación con período anterior
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
   * Calcula predicciones financieras mejoradas
   * Incluye proyección a fin de mes basada en datos quincenales
   */
  private static async calculatePredictions(
    userId: string,
    periodIncome: number,
    periodExpenses: number,
    budgets: BudgetStatus[],
    currency: string,
    periodType: 'FIRST_HALF' | 'SECOND_HALF' = 'FIRST_HALF'
  ): Promise<Predictions> {
    const now = new Date();
    const currentMonth = now.getMonth();
    const currentYear = now.getFullYear();
    const lastDayOfMonth = new Date(currentYear, currentMonth + 1, 0).getDate();
    const currentDay = now.getDate();

    // Obtener datos históricos del usuario para mejor proyección
    const lastMonthStart = new Date(currentYear, currentMonth - 1, 1);
    const lastMonthEnd = new Date(currentYear, currentMonth, 0, 23, 59, 59);

    const lastMonthTransactions = await prisma.transaction.findMany({
      where: {
        userId,
        date: { gte: lastMonthStart, lte: lastMonthEnd }
      }
    });

    const lastMonthIncome = lastMonthTransactions
      .filter(t => t.type === 'INCOME')
      .reduce((sum, t) => sum + Number(t.amount), 0);

    const lastMonthExpenses = lastMonthTransactions
      .filter(t => t.type === 'EXPENSE')
      .reduce((sum, t) => sum + Number(t.amount), 0);

    // Calcular proyección a fin de mes
    let projectedExpenses: number;
    let projectedIncome: number;
    let monthlyTrend: string;

    if (periodType === 'FIRST_HALF') {
      // Tenemos datos de la primera quincena, proyectar la segunda
      projectedExpenses = periodExpenses * 2; // Aproximación simple
      projectedIncome = periodIncome * 2;

      // Ajustar con datos históricos si existen
      if (lastMonthExpenses > 0) {
        const lastMonthRatio = lastMonthExpenses / 2; // Promedio quincenal del mes pasado
        projectedExpenses = periodExpenses + lastMonthRatio;
      }
    } else {
      // Tenemos datos de la segunda quincena del mes anterior
      // Usar como referencia para el mes actual
      projectedExpenses = periodExpenses * 2;
      projectedIncome = periodIncome * 2;
    }

    const endOfMonthSavings = Math.round((projectedIncome - projectedExpenses) * 100) / 100;
    const endOfMonthBalance = Math.round((periodIncome - periodExpenses) * 100) / 100;

    // Determinar tendencia
    if (endOfMonthSavings > 0) {
      monthlyTrend = `Si sigues así, terminarás el mes con +${currency}${endOfMonthSavings.toLocaleString()} de ahorro`;
    } else if (endOfMonthSavings < 0) {
      monthlyTrend = `⚠️ A este ritmo, te faltarán ${currency}${Math.abs(endOfMonthSavings).toLocaleString()} a fin de mes`;
    } else {
      monthlyTrend = 'Vas equilibrado - tus ingresos cubren tus gastos';
    }

    // Advertencias de presupuesto
    const budgetWarnings: string[] = [];
    budgets.forEach(b => {
      if (b.percentage >= 90 && !b.isExceeded) {
        budgetWarnings.push(`${b.name} está al ${b.percentage}%, considera reducir gastos`);
      } else if (b.isExceeded) {
        budgetWarnings.push(`${b.name} excedido por ${currency}${(b.spent - b.limit).toFixed(2)}`);
      }
    });

    // Proyección de ahorros anual
    const monthlyNet = projectedIncome - projectedExpenses;
    const savingsProjection = Math.round(monthlyNet * 12);

    return {
      endOfMonthSavings,
      endOfMonthBalance,
      projectedExpenses: Math.round(projectedExpenses * 100) / 100,
      budgetWarnings,
      savingsProjection,
      monthlyTrend
    };
  }

  /**
   * Calcula el score financiero (0-100)
   * Nueva fórmula optimizada para Latam y Gen Z:
   * - Base 0 (todo se gana)
   * - Ahorro: 25 pts max (menos peso por ingresos irregulares)
   * - Presupuestos: 30 pts max (esto SÍ controlan)
   * - Metas: 20 pts max (motivar ahorro a largo plazo)
   * - Gastos hormiga: 25 pts max (principal problema Gen Z)
   */
  private static calculateFinancialScore(
    savingsRate: number,
    budgets: BudgetStatus[],
    goals: GoalProgress[],
    antPercentage: number,
    hasIncome: boolean = true
  ): number {
    let score = 0; // Base 0 - todo se gana

    // 1. AHORRO (25 puntos max)
    if (savingsRate >= 20) {
      score += 25;
    } else if (savingsRate >= 10) {
      score += 20;
    } else if (savingsRate >= 0 && hasIncome) {
      score += 15;
    } else if (!hasIncome) {
      // Sin ingresos esta quincena (normal en Latam) - no penalizar tanto
      score += 10;
    } else {
      // Negativo (gastó más de lo que ganó)
      score += 5;
    }

    // 2. PRESUPUESTOS (30 puntos max)
    if (budgets.length > 0) {
      const avgBudgetUsage = budgets.reduce((sum, b) => sum + b.percentage, 0) / budgets.length;
      const exceededCount = budgets.filter(b => b.isExceeded).length;

      if (exceededCount === 0 && avgBudgetUsage <= 80) {
        score += 30;
      } else if (exceededCount === 0 && avgBudgetUsage <= 95) {
        score += 20;
      } else if (exceededCount <= 1) {
        score += 10;
      }
      // Si más de 1 excedido, no suma puntos
    } else {
      // No tiene presupuestos - dar puntos mínimos para incentivar crear
      score += 5;
    }

    // 3. METAS (20 puntos max)
    if (goals.length > 0) {
      const avgProgress = goals.reduce((sum, g) => sum + g.percentage, 0) / goals.length;
      if (avgProgress >= 50) {
        score += 20;
      } else if (avgProgress >= 25) {
        score += 15;
      } else {
        score += 10;
      }
    }
    // Si no tiene metas, no suma puntos (incentivar a crear)

    // 4. GASTOS HORMIGA (25 puntos max)
    if (antPercentage <= 5) {
      score += 25;
    } else if (antPercentage <= 10) {
      score += 20;
    } else if (antPercentage <= 20) {
      score += 15;
    } else if (antPercentage <= 30) {
      score += 10;
    } else {
      score += 5;
    }

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
