/**
 * Servicio de Análisis de Gastos Hormiga
 * Detective de Gastos Hormiga - FinZen AI
 *
 * Este servicio realiza todos los cálculos numéricos para el análisis
 * de gastos hormiga. La generación de insights creativos se delega a Zenio IA.
 */

import { PrismaClient } from '@prisma/client';
import {
  AntExpenseConfig,
  DEFAULT_ANT_EXPENSE_CONFIG,
  CONFIG_LIMITS,
  CategoryStats,
  MonthlyData,
  DayOfWeekData,
  TrendDirection,
  UserHistoryInfo,
  AnalysisMetadata,
  AntExpenseCalculations,
  AnalysisWarning,
} from '../types/antExpense';

const prisma = new PrismaClient();

// =============================================
// CONSTANTES
// =============================================

const MONTH_NAMES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
const DAY_NAMES = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

// =============================================
// CLASE PRINCIPAL DEL SERVICIO
// =============================================

export class AntExpenseService {
  /**
   * Valida y normaliza la configuración del usuario
   */
  validateAndNormalizeConfig(userConfig?: Partial<AntExpenseConfig>): AntExpenseConfig {
    const config: AntExpenseConfig = {
      antThreshold: userConfig?.antThreshold ?? DEFAULT_ANT_EXPENSE_CONFIG.antThreshold,
      minFrequency: userConfig?.minFrequency ?? DEFAULT_ANT_EXPENSE_CONFIG.minFrequency,
      monthsToAnalyze: userConfig?.monthsToAnalyze ?? DEFAULT_ANT_EXPENSE_CONFIG.monthsToAnalyze,
    };

    // Validar límites
    config.antThreshold = Math.max(
      CONFIG_LIMITS.antThreshold.min,
      Math.min(CONFIG_LIMITS.antThreshold.max, config.antThreshold)
    );

    config.minFrequency = Math.max(
      CONFIG_LIMITS.minFrequency.min,
      Math.min(CONFIG_LIMITS.minFrequency.max, config.minFrequency)
    );

    config.monthsToAnalyze = Math.max(
      CONFIG_LIMITS.monthsToAnalyze.min,
      Math.min(CONFIG_LIMITS.monthsToAnalyze.max, config.monthsToAnalyze)
    );

    return config;
  }

  /**
   * Obtiene información sobre el historial del usuario
   */
  async getUserHistoryInfo(userId: string): Promise<UserHistoryInfo> {
    // Obtener la primera transacción del usuario
    const firstTransaction = await prisma.transaction.findFirst({
      where: { userId },
      orderBy: { date: 'asc' },
      select: { date: true },
    });

    if (!firstTransaction) {
      return {
        firstTransactionDate: null,
        monthsWithData: 0,
        hasEnoughData: false,
        totalTransactionsInPeriod: 0,
        totalExpensesInPeriod: 0,
      };
    }

    // Calcular meses con datos
    const now = new Date();
    const firstDate = new Date(firstTransaction.date);
    const monthsDiff = (now.getFullYear() - firstDate.getFullYear()) * 12
                      + (now.getMonth() - firstDate.getMonth()) + 1;

    // Contar transacciones totales
    const totalTransactions = await prisma.transaction.count({
      where: { userId },
    });

    const totalExpenses = await prisma.transaction.count({
      where: { userId, type: 'EXPENSE' },
    });

    return {
      firstTransactionDate: firstDate,
      monthsWithData: Math.max(1, monthsDiff),
      hasEnoughData: monthsDiff >= 1 && totalExpenses >= 5,
      totalTransactionsInPeriod: totalTransactions,
      totalExpensesInPeriod: totalExpenses,
    };
  }

  /**
   * Genera advertencias basadas en la configuración y datos del usuario
   */
  generateWarnings(config: AntExpenseConfig, userHistory: UserHistoryInfo): AnalysisWarning[] {
    const warnings: AnalysisWarning[] = [];

    // Verificar si tiene suficiente historial
    if (userHistory.monthsWithData < config.monthsToAnalyze) {
      warnings.push({
        type: 'info',
        message: `Solo tienes ${userHistory.monthsWithData} mes(es) de historial. El análisis se realizará con los datos disponibles.`,
      });
    }

    // Advertencia si elige menos de 3 meses
    if (config.monthsToAnalyze < 3) {
      warnings.push({
        type: 'info',
        message: 'Con menos de 3 meses de datos, algunos patrones de gasto podrían no detectarse correctamente.',
      });
    }

    // Advertencia si el monto es muy alto
    if (config.antThreshold > 1000) {
      warnings.push({
        type: 'info',
        message: `Un monto alto (>${config.antThreshold}) puede incluir gastos que no son típicamente "hormiga".`,
      });
    }

    // Advertencia si el monto es muy bajo
    if (config.antThreshold < 200) {
      warnings.push({
        type: 'info',
        message: 'Un monto muy bajo podría excluir gastos hormiga relevantes como cafés o snacks.',
      });
    }

    // Advertencia si frecuencia es muy alta
    if (config.minFrequency > 5) {
      warnings.push({
        type: 'info',
        message: `Una frecuencia alta (>${config.minFrequency}) podría excluir gastos problemáticos menos frecuentes.`,
      });
    }

    // Pocas transacciones
    if (userHistory.totalExpensesInPeriod < 10) {
      warnings.push({
        type: 'warning',
        message: 'Tienes pocas transacciones registradas. El análisis será más preciso con más datos.',
      });
    }

    return warnings;
  }

  /**
   * Obtiene las transacciones del período especificado
   */
  async getTransactionsInPeriod(
    userId: string,
    monthsToAnalyze: number
  ): Promise<{
    allExpenses: any[];
    periodStart: Date;
    periodEnd: Date;
  }> {
    const periodEnd = new Date();
    const periodStart = new Date();
    periodStart.setMonth(periodStart.getMonth() - monthsToAnalyze);
    periodStart.setHours(0, 0, 0, 0);

    const transactions = await prisma.transaction.findMany({
      where: {
        userId,
        type: 'EXPENSE',
        date: {
          gte: periodStart,
          lte: periodEnd,
        },
      },
      include: {
        category: {
          select: {
            name: true,
            icon: true,
          },
        },
      },
      orderBy: { date: 'desc' },
    });

    return {
      allExpenses: transactions,
      periodStart,
      periodEnd,
    };
  }

  /**
   * Filtra transacciones que califican como "hormiga"
   */
  filterAntExpenses(transactions: any[], antThreshold: number): any[] {
    return transactions.filter(t => t.amount <= antThreshold);
  }

  /**
   * Agrupa transacciones por categoría
   */
  groupByCategory(transactions: any[]): Record<string, any[]> {
    return transactions.reduce((acc, t) => {
      const categoryName = t.category?.name || 'Sin categoría';
      if (!acc[categoryName]) {
        acc[categoryName] = [];
      }
      acc[categoryName].push(t);
      return acc;
    }, {} as Record<string, any[]>);
  }

  /**
   * Calcula la frecuencia legible
   */
  calculateFrequencyString(count: number, months: number): string {
    if (months === 0) return '0 veces';

    const perMonth = count / months;
    const perWeek = perMonth / 4;

    if (perWeek >= 2) {
      return `${Math.round(perWeek)} veces/semana`;
    } else if (perWeek >= 1) {
      return `${Math.round(perWeek)} vez/semana`;
    } else if (perMonth >= 1) {
      return `${Math.round(perMonth)} veces/mes`;
    } else {
      return `${count} veces en ${months} meses`;
    }
  }

  /**
   * Calcula la tendencia comparando el mes actual con el anterior
   */
  calculateTrend(transactions: any[]): { direction: TrendDirection; percentage: number } {
    const now = new Date();
    const thisMonth = now.getMonth();
    const thisYear = now.getFullYear();

    const lastMonth = thisMonth === 0 ? 11 : thisMonth - 1;
    const lastYear = thisMonth === 0 ? thisYear - 1 : thisYear;

    const thisMonthTotal = transactions
      .filter(t => {
        const date = new Date(t.date);
        return date.getMonth() === thisMonth && date.getFullYear() === thisYear;
      })
      .reduce((sum, t) => sum + t.amount, 0);

    const lastMonthTotal = transactions
      .filter(t => {
        const date = new Date(t.date);
        return date.getMonth() === lastMonth && date.getFullYear() === lastYear;
      })
      .reduce((sum, t) => sum + t.amount, 0);

    if (lastMonthTotal === 0) {
      return { direction: 'stable', percentage: 0 };
    }

    const change = ((thisMonthTotal - lastMonthTotal) / lastMonthTotal) * 100;

    if (change > 10) {
      return { direction: 'up', percentage: Math.round(change) };
    } else if (change < -10) {
      return { direction: 'down', percentage: Math.round(change) };
    }
    return { direction: 'stable', percentage: Math.round(change) };
  }

  /**
   * Calcula estadísticas por categoría
   */
  calculateCategoryStats(
    groupedTransactions: Record<string, any[]>,
    totalAntExpenses: number,
    monthsAnalyzed: number,
    transactions: any[]
  ): CategoryStats[] {
    const stats: CategoryStats[] = [];

    for (const [categoryName, txns] of Object.entries(groupedTransactions)) {
      const total = txns.reduce((sum, t) => sum + t.amount, 0);
      const count = txns.length;
      const average = count > 0 ? Math.round(total / count) : 0;
      const frequencyPerMonth = monthsAnalyzed > 0 ? count / monthsAnalyzed : 0;
      const trend = this.calculateTrend(txns);
      const icon = txns[0]?.category?.icon || '📝';

      stats.push({
        category: categoryName,
        icon,
        total: Math.round(total * 100) / 100,
        count,
        average,
        frequency: this.calculateFrequencyString(count, monthsAnalyzed),
        frequencyPerMonth: Math.round(frequencyPerMonth * 100) / 100,
        percentageOfAntTotal: totalAntExpenses > 0
          ? Math.round((total / totalAntExpenses) * 100)
          : 0,
        trend: trend.direction,
        trendPercentage: trend.percentage,
      });
    }

    // Ordenar por total descendente
    return stats.sort((a, b) => b.total - a.total);
  }

  /**
   * Calcula la tendencia mensual
   */
  calculateMonthlyTrend(transactions: any[]): MonthlyData[] {
    const byMonth: Record<string, any[]> = {};

    transactions.forEach(t => {
      const date = new Date(t.date);
      const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

      if (!byMonth[monthKey]) {
        byMonth[monthKey] = [];
      }
      byMonth[monthKey].push(t);
    });

    const monthlyData: MonthlyData[] = Object.entries(byMonth)
      .map(([monthKey, txns]) => {
        const [year, month] = monthKey.split('-');
        const monthIndex = parseInt(month) - 1;
        const total = txns.reduce((sum, t) => sum + t.amount, 0);

        return {
          monthKey,
          monthName: `${MONTH_NAMES[monthIndex]} ${year}`,
          total: Math.round(total * 100) / 100,
          count: txns.length,
          average: txns.length > 0 ? Math.round(total / txns.length) : 0,
        };
      })
      .sort((a, b) => a.monthKey.localeCompare(b.monthKey));

    return monthlyData;
  }

  /**
   * Calcula gastos por día de la semana
   */
  calculateByDayOfWeek(transactions: any[]): DayOfWeekData[] {
    const byDay: Record<number, any[]> = {};

    // Inicializar todos los días
    for (let i = 0; i < 7; i++) {
      byDay[i] = [];
    }

    transactions.forEach(t => {
      const day = new Date(t.date).getDay();
      byDay[day].push(t);
    });

    return Object.entries(byDay)
      .map(([dayNumber, txns]) => {
        const day = parseInt(dayNumber);
        const total = txns.reduce((sum, t) => sum + t.amount, 0);

        return {
          dayNumber: day,
          dayName: DAY_NAMES[day],
          total: Math.round(total * 100) / 100,
          count: txns.length,
          average: txns.length > 0 ? Math.round(total / txns.length) : 0,
        };
      })
      .sort((a, b) => a.dayNumber - b.dayNumber);
  }

  /**
   * Encuentra el día con más gastos hormiga
   */
  findMostExpensiveDay(byDayOfWeek: DayOfWeekData[]): DayOfWeekData | null {
    if (byDayOfWeek.length === 0) return null;

    return byDayOfWeek.reduce((max, day) =>
      day.total > max.total ? day : max
    , byDayOfWeek[0]);
  }

  /**
   * FUNCIÓN PRINCIPAL: Calcula todas las estadísticas de gastos hormiga
   */
  async calculateAntExpenseStats(
    userId: string,
    userConfig?: Partial<AntExpenseConfig>
  ): Promise<{
    calculations: AntExpenseCalculations | null;
    warnings: AnalysisWarning[];
    canAnalyze: boolean;
    cannotAnalyzeReason?: string;
  }> {
    console.log(`[AntExpenseService] Iniciando análisis para usuario ${userId}`);

    // 1. Validar configuración
    const config = this.validateAndNormalizeConfig(userConfig);
    console.log(`[AntExpenseService] Configuración: ${JSON.stringify(config)}`);

    // 2. Obtener información del historial del usuario
    const userHistory = await this.getUserHistoryInfo(userId);
    console.log(`[AntExpenseService] Historial del usuario: ${JSON.stringify(userHistory)}`);

    // 3. Verificar si puede analizar
    if (!userHistory.hasEnoughData) {
      return {
        calculations: null,
        warnings: [],
        canAnalyze: false,
        cannotAnalyzeReason: userHistory.totalExpensesInPeriod === 0
          ? 'No tienes transacciones registradas aún. ¡Comienza a registrar tus gastos para que pueda analizarlos!'
          : 'Necesitas al menos 5 transacciones de gasto para realizar un análisis significativo.',
      };
    }

    // 4. Generar advertencias
    const warnings = this.generateWarnings(config, userHistory);

    // 5. Obtener transacciones del período
    const { allExpenses, periodStart, periodEnd } = await this.getTransactionsInPeriod(
      userId,
      config.monthsToAnalyze
    );
    console.log(`[AntExpenseService] Transacciones obtenidas: ${allExpenses.length}`);

    // Si no hay transacciones en el período
    if (allExpenses.length === 0) {
      return {
        calculations: null,
        warnings,
        canAnalyze: false,
        cannotAnalyzeReason: `No tienes gastos registrados en los últimos ${config.monthsToAnalyze} mes(es). Tus transacciones pueden ser más antiguas o solo tienes ingresos registrados.`,
      };
    }

    // 6. Filtrar gastos hormiga
    const antExpenses = this.filterAntExpenses(allExpenses, config.antThreshold);
    console.log(`[AntExpenseService] Gastos hormiga encontrados: ${antExpenses.length} de ${allExpenses.length} gastos totales`);

    // Si no hay gastos que califiquen como "hormiga"
    if (antExpenses.length === 0) {
      return {
        calculations: null,
        warnings,
        canAnalyze: false,
        cannotAnalyzeReason: `Tienes ${allExpenses.length} gastos registrados, pero ninguno es menor o igual a RD$${config.antThreshold.toLocaleString()}. Ajusta el umbral de monto máximo o registra gastos más pequeños.`,
      };
    }

    // Calcular totales
    const totalAllExpenses = allExpenses.reduce((sum, t) => sum + t.amount, 0);
    const totalAntExpenses = antExpenses.reduce((sum, t) => sum + t.amount, 0);

    // 7. Calcular meses realmente analizados
    const actualMonthsAnalyzed = Math.min(config.monthsToAnalyze, userHistory.monthsWithData);

    // 8. Agrupar por categoría
    const groupedByCategory = this.groupByCategory(antExpenses);

    // 9. Calcular estadísticas por categoría
    const categoryStats = this.calculateCategoryStats(
      groupedByCategory,
      totalAntExpenses,
      actualMonthsAnalyzed,
      antExpenses
    );

    // 10. Filtrar por frecuencia mínima para top criminals
    const topCriminals = categoryStats.filter(
      cat => cat.count >= config.minFrequency
    ).slice(0, 5); // Top 5

    // 11. Calcular tendencia mensual
    const monthlyTrend = this.calculateMonthlyTrend(antExpenses);

    // 12. Calcular gastos por día de la semana
    const byDayOfWeek = this.calculateByDayOfWeek(antExpenses);
    const mostExpensiveDay = this.findMostExpensiveDay(byDayOfWeek);

    // 13. Calcular oportunidad de ahorro y promedio diario
    const savingsOpportunityPerMonth = actualMonthsAnalyzed > 0
      ? Math.round(totalAntExpenses / actualMonthsAnalyzed)
      : 0;

    const daysInPeriod = Math.max(1,
      Math.round((periodEnd.getTime() - periodStart.getTime()) / (1000 * 60 * 60 * 24))
    );
    const averagePerDay = Math.round(totalAntExpenses / daysInPeriod);

    // 14. Construir metadata
    const metadata: AnalysisMetadata = {
      configUsed: config,
      periodStart,
      periodEnd,
      actualMonthsAnalyzed,
      userHistory: {
        ...userHistory,
        totalTransactionsInPeriod: allExpenses.length,
        totalExpensesInPeriod: allExpenses.length,
      },
      antTransactionsCount: antExpenses.length,
      antPercentageOfExpenses: allExpenses.length > 0
        ? Math.round((antExpenses.length / allExpenses.length) * 100)
        : 0,
      analyzedAt: new Date(),
    };

    // 15. Construir resultado
    const calculations: AntExpenseCalculations = {
      totalAntExpenses: Math.round(totalAntExpenses * 100) / 100,
      totalAllExpenses: Math.round(totalAllExpenses * 100) / 100,
      percentageOfTotal: totalAllExpenses > 0
        ? Math.round((totalAntExpenses / totalAllExpenses) * 100)
        : 0,
      topCriminals,
      monthlyTrend,
      byDayOfWeek,
      mostExpensiveDay,
      savingsOpportunityPerMonth,
      averagePerDay,
      metadata,
    };

    console.log(`[AntExpenseService] Análisis completado. Total hormiga: ${totalAntExpenses}`);

    return {
      calculations,
      warnings,
      canAnalyze: true,
    };
  }

  /**
   * Prepara datos resumidos para enviar a Zenio IA
   * (Reducimos la cantidad de datos para optimizar tokens)
   */
  prepareDataForZenio(calculations: AntExpenseCalculations): object {
    return {
      totalAntExpenses: calculations.totalAntExpenses,
      totalAllExpenses: calculations.totalAllExpenses,
      percentageOfTotal: calculations.percentageOfTotal,
      savingsOpportunityPerMonth: calculations.savingsOpportunityPerMonth,
      averagePerDay: calculations.averagePerDay,
      mostExpensiveDay: calculations.mostExpensiveDay?.dayName || 'N/A',
      monthsAnalyzed: calculations.metadata.actualMonthsAnalyzed,
      antTransactionsCount: calculations.metadata.antTransactionsCount,
      topCriminals: calculations.topCriminals.map(c => ({
        category: c.category,
        total: c.total,
        count: c.count,
        frequency: c.frequency,
        percentageOfAnt: c.percentageOfAntTotal,
        trend: c.trend,
      })),
      monthlyTrend: calculations.monthlyTrend.map(m => ({
        month: m.monthName,
        total: m.total,
      })),
    };
  }
}

// Exportar instancia singleton
export const antExpenseService = new AntExpenseService();
