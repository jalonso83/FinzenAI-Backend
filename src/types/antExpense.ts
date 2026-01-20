/**
 * Tipos e interfaces para el análisis de Gastos Hormiga
 * Detective de Gastos Hormiga - FinZen AI
 */

// =============================================
// CONFIGURACIÓN DEL ANÁLISIS
// =============================================

/**
 * Configuración parametrizable para el análisis de gastos hormiga
 */
export interface AntExpenseConfig {
  /** Monto máximo para considerar un gasto como "hormiga" (en moneda local) */
  antThreshold: number;

  /** Frecuencia mínima de transacciones para detectar un patrón */
  minFrequency: number;

  /** Cantidad de meses a analizar */
  monthsToAnalyze: number;
}

/**
 * Valores por defecto recomendados
 */
export const DEFAULT_ANT_EXPENSE_CONFIG: AntExpenseConfig = {
  antThreshold: 500,      // RD$500 máximo
  minFrequency: 3,        // 3 veces mínimo
  monthsToAnalyze: 3,     // 3 meses
};

/**
 * Límites de configuración (para validación)
 */
export const CONFIG_LIMITS = {
  antThreshold: {
    min: 50,
    max: 5000,
    options: [50, 100, 200, 300, 500, 750, 1000, 1500, 2000, 3000, 5000],
  },
  minFrequency: {
    min: 2,
    max: 20,
    options: [2, 3, 4, 5, 7, 10, 15, 20],
  },
  monthsToAnalyze: {
    min: 1,
    max: 12,
    options: [1, 2, 3, 6, 9, 12],
  },
};

// =============================================
// ESTADÍSTICAS POR CATEGORÍA
// =============================================

/**
 * Tendencia de una categoría comparando períodos
 */
export type TrendDirection = 'up' | 'down' | 'stable';

/**
 * Estadísticas detalladas de una categoría de gastos hormiga
 */
export interface CategoryStats {
  /** Nombre de la categoría */
  category: string;

  /** Icono de la categoría */
  icon: string;

  /** Total gastado en esta categoría (dentro del umbral hormiga) */
  total: number;

  /** Cantidad de transacciones */
  count: number;

  /** Monto promedio por transacción */
  average: number;

  /** Frecuencia legible ("5 veces/mes", "2 veces/semana") */
  frequency: string;

  /** Frecuencia numérica por mes */
  frequencyPerMonth: number;

  /** Porcentaje que representa del total de gastos hormiga */
  percentageOfAntTotal: number;

  /** Tendencia comparando meses */
  trend: TrendDirection;

  /** Cambio porcentual vs mes anterior */
  trendPercentage: number;
}

// =============================================
// DATOS MENSUALES
// =============================================

/**
 * Datos agregados por mes
 */
export interface MonthlyData {
  /** Clave del mes (YYYY-MM) */
  monthKey: string;

  /** Nombre legible ("Oct 2025") */
  monthName: string;

  /** Total de gastos hormiga en el mes */
  total: number;

  /** Cantidad de transacciones hormiga */
  count: number;

  /** Promedio por transacción */
  average: number;
}

// =============================================
// DATOS POR DÍA DE LA SEMANA
// =============================================

/**
 * Datos agregados por día de la semana
 */
export interface DayOfWeekData {
  /** Número del día (0=Domingo, 6=Sábado) */
  dayNumber: number;

  /** Nombre del día */
  dayName: string;

  /** Total gastado ese día de la semana */
  total: number;

  /** Cantidad de transacciones */
  count: number;

  /** Promedio por transacción */
  average: number;
}

// =============================================
// METADATA DEL ANÁLISIS
// =============================================

/**
 * Información sobre el usuario y su historial
 */
export interface UserHistoryInfo {
  /** Fecha de la primera transacción del usuario */
  firstTransactionDate: Date | null;

  /** Cantidad de meses con datos disponibles */
  monthsWithData: number;

  /** Si tiene suficientes datos para un análisis confiable */
  hasEnoughData: boolean;

  /** Total de transacciones en el período */
  totalTransactionsInPeriod: number;

  /** Total de transacciones de tipo EXPENSE */
  totalExpensesInPeriod: number;
}

/**
 * Metadata completa del análisis
 */
export interface AnalysisMetadata {
  /** Configuración utilizada */
  configUsed: AntExpenseConfig;

  /** Fecha de inicio del período analizado */
  periodStart: Date;

  /** Fecha de fin del período analizado */
  periodEnd: Date;

  /** Meses realmente analizados (puede ser menor que monthsToAnalyze) */
  actualMonthsAnalyzed: number;

  /** Información del historial del usuario */
  userHistory: UserHistoryInfo;

  /** Transacciones que califican como hormiga */
  antTransactionsCount: number;

  /** Porcentaje de gastos que son hormiga */
  antPercentageOfExpenses: number;

  /** Timestamp del análisis */
  analyzedAt: Date;
}

// =============================================
// RESULTADO PRINCIPAL DEL CÁLCULO
// =============================================

/**
 * Resultado completo de los cálculos del backend
 * (Sin insights de IA - esos se generan aparte)
 */
export interface AntExpenseCalculations {
  /** Total de gastos hormiga en el período */
  totalAntExpenses: number;

  /** Total de TODOS los gastos en el período (para contexto) */
  totalAllExpenses: number;

  /** Porcentaje que representan los gastos hormiga del total */
  percentageOfTotal: number;

  /** Top categorías "criminales" ordenadas por total (filtradas por frecuencia) */
  topCriminals: CategoryStats[];

  /** Todas las categorías ordenadas por total (sin filtro de frecuencia) */
  allCategoryStats?: CategoryStats[];

  /** Tendencia mensual */
  monthlyTrend: MonthlyData[];

  /** Gastos por día de la semana */
  byDayOfWeek: DayOfWeekData[];

  /** Día de la semana con más gastos hormiga */
  mostExpensiveDay: DayOfWeekData | null;

  /** Oportunidad de ahorro mensual (promedio) */
  savingsOpportunityPerMonth: number;

  /** Promedio diario de gastos hormiga */
  averagePerDay: number;

  /** Metadata del análisis */
  metadata: AnalysisMetadata;
}

// =============================================
// INSIGHTS DE IA (ZENIO)
// =============================================

/**
 * Sugerencias generadas por categoría
 */
export interface CategorySuggestions {
  category: string;
  suggestions: string[];
}

/**
 * Insights creativos generados por Zenio IA
 */
export interface ZenioInsights {
  /** Mensaje principal de impacto */
  impactMessage: string;

  /** Equivalencias motivacionales */
  equivalencies: string[];

  /** Sugerencias específicas por categoría */
  categorySuggestions: CategorySuggestions[];

  /** Mensaje motivacional final */
  motivationalMessage: string;

  /** Nivel de severidad del problema (1-5) */
  severityLevel: number;

  /** Resumen ejecutivo corto */
  summary: string;
}

// =============================================
// RESPUESTA COMPLETA DEL API
// =============================================

/**
 * Advertencia para el usuario
 */
export interface AnalysisWarning {
  type: 'info' | 'warning' | 'error';
  message: string;
}

/**
 * Información del plan para restricciones de análisis
 */
export interface PlanInfo {
  /** Plan actual del usuario */
  currentPlan: string;

  /** Tipo de análisis disponible: 'basic' o 'full' */
  analysisType: 'basic' | 'full';

  /** Si el análisis está limitado */
  isLimited: boolean;

  /** Mensaje de upgrade (solo si isLimited=true) */
  upgradeMessage?: string;
}

/**
 * Respuesta completa del endpoint de análisis
 */
export interface AntExpenseAnalysisResponse {
  /** Si el análisis fue exitoso */
  success: boolean;

  /** Si se puede realizar el análisis */
  canAnalyze: boolean;

  /** Mensaje si no se puede analizar */
  cannotAnalyzeReason?: string;

  /** Cálculos del backend */
  calculations: AntExpenseCalculations | null;

  /** Insights de Zenio IA */
  insights: ZenioInsights | null;

  /** Advertencias para el usuario */
  warnings: AnalysisWarning[];

  /** Configuración recomendada (para UI) */
  recommendedConfig: AntExpenseConfig;

  /** Opciones de configuración disponibles (para UI) */
  configOptions: typeof CONFIG_LIMITS;

  /** Información sobre restricciones del plan (solo presente si hay análisis) */
  planInfo?: PlanInfo;
}

// =============================================
// REQUEST DEL CLIENTE
// =============================================

/**
 * Parámetros que el cliente puede enviar
 */
export interface AntExpenseAnalysisRequest {
  /** Configuración personalizada (opcional, usa defaults si no se envía) */
  config?: Partial<AntExpenseConfig>;
}
