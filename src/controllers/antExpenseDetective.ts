/**
 * Controlador del Detective de Gastos Hormiga
 * FinZen AI
 *
 * Este controlador maneja las peticiones del análisis de gastos hormiga.
 * Utiliza el servicio antExpenseService para cálculos y Zenio IA para insights.
 */

import { Request, Response } from 'express';
import { antExpenseService } from '../services/antExpenseService';
import { subscriptionService } from '../services/subscriptionService';
import { PLANS } from '../config/stripe';
import {
  AntExpenseConfig,
  DEFAULT_ANT_EXPENSE_CONFIG,
  CONFIG_LIMITS,
  AntExpenseAnalysisResponse,
  ZenioInsights,
  AntExpenseCalculations,
} from '../types/antExpense';

// =============================================
// FUNCIÓN PARA GENERAR INSIGHTS CON ZENIO IA
// =============================================

/**
 * Genera insights creativos usando Zenio IA
 * Recibe datos pre-calculados y genera texto personalizado
 */
async function generateZenioInsights(
  calculations: AntExpenseCalculations,
  userId: string
): Promise<ZenioInsights> {
  try {
    // Preparar datos resumidos para la IA
    const dataForZenio = antExpenseService.prepareDataForZenio(calculations);

    console.log('[AntDetective] Preparando datos para Zenio IA...');
    console.log('[AntDetective] Datos para Zenio:', JSON.stringify(dataForZenio, null, 2));

    // Importar el controlador de Zenio
    const { chatWithZenio } = await import('./zenio');

    // Crear el prompt específico para análisis de gastos hormiga
    const analysisPrompt = `
Analiza estos datos de gastos hormiga y genera insights creativos en español:

DATOS CALCULADOS:
${JSON.stringify(dataForZenio, null, 2)}

Genera una respuesta JSON con esta estructura exacta:
{
  "impactMessage": "Mensaje principal de impacto (2-3 oraciones, usa emojis)",
  "equivalencies": ["Array de 3-4 equivalencias creativas de qué podría comprar con ese dinero"],
  "categorySuggestions": [
    {
      "category": "nombre de categoría",
      "suggestions": ["2-3 sugerencias específicas para reducir gastos en esta categoría"]
    }
  ],
  "motivationalMessage": "Mensaje motivacional final (1-2 oraciones con emoji)",
  "severityLevel": número del 1 al 5 según qué tan grave es el problema,
  "summary": "Resumen ejecutivo en una oración"
}

Considera:
- El usuario está en República Dominicana (usa RD$ para montos)
- Sé específico con las sugerencias según las categorías detectadas
- Las equivalencias deben ser relevantes y motivadoras
- El severityLevel: 1=muy bien, 2=bien, 3=regular, 4=preocupante, 5=crítico
`;

    // Variable para capturar la respuesta y el estado
    let zenioResponse: any = null;
    let responseStatus: number = 200;

    // Mock request y response para llamar a chatWithZenio
    const mockReq = {
      user: { id: userId },
      body: {
        message: analysisPrompt,
        threadId: undefined,
        isOnboarding: false,
        categories: [],
        transactions: [],
        timezone: 'America/Santo_Domingo',
      },
    } as any;

    const mockRes = {
      status: (code: number) => {
        responseStatus = code;
        return mockRes;
      },
      json: (data: any) => {
        zenioResponse = data;
        return mockRes;
      },
    } as any;

    // Llamar a Zenio con timeout de 30 segundos
    const timeoutPromise = new Promise<void>((_, reject) => {
      setTimeout(() => reject(new Error('Timeout: Zenio tardó más de 30 segundos')), 30000);
    });

    try {
      await Promise.race([
        chatWithZenio(mockReq, mockRes),
        timeoutPromise
      ]);
    } catch (timeoutError) {
      console.error('[AntDetective] Timeout o error en llamada a Zenio:', timeoutError);
      console.log('[AntDetective] Usando fallback por timeout');
      return generateFallbackInsights(calculations);
    }

    // Verificar si hubo error en la respuesta
    if (responseStatus >= 400) {
      console.error('[AntDetective] Zenio retornó error:', responseStatus, zenioResponse);
      console.log('[AntDetective] Usando fallback por error de Zenio');
      return generateFallbackInsights(calculations);
    }

    // Extraer respuesta JSON de Zenio
    if (zenioResponse?.message) {
      console.log('[AntDetective] Respuesta de Zenio recibida, longitud:', zenioResponse.message.length);
      try {
        // Buscar el JSON que contiene "impactMessage" (el JSON correcto)
        // Primero intentar encontrar un bloque JSON que empiece con {"impactMessage"
        let jsonString: string | null = null;

        // Método 1: Buscar JSON que contenga impactMessage
        const impactMatch = zenioResponse.message.match(/\{[^{}]*"impactMessage"[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/s);
        if (impactMatch) {
          jsonString = impactMatch[0];
        }

        // Método 2: Si no funciona, buscar el JSON más grande (probablemente el correcto)
        if (!jsonString) {
          const allJsonMatches = zenioResponse.message.match(/\{[^{}]*(?:\[[^\[\]]*\]|"[^"]*"|\{[^{}]*\}|[^{}])*\}/g);
          if (allJsonMatches && allJsonMatches.length > 0) {
            // Buscar el que contenga "impactMessage"
            jsonString = allJsonMatches.find(j => j.includes('impactMessage')) || null;

            // Si no, tomar el más largo
            if (!jsonString) {
              jsonString = allJsonMatches.reduce((a, b) => a.length > b.length ? a : b);
            }
          }
        }

        // Método 3: Fallback - regex greedy original
        if (!jsonString) {
          const greedyMatch = zenioResponse.message.match(/\{[\s\S]*\}/);
          if (greedyMatch) {
            jsonString = greedyMatch[0];
          }
        }

        if (jsonString) {
          console.log('[AntDetective] JSON encontrado, intentando parsear...');
          const parsed = JSON.parse(jsonString);

          // Verificar que tenga los campos esperados
          if (parsed.impactMessage || parsed.equivalencies || parsed.summary) {
            console.log('[AntDetective] JSON parseado exitosamente con campos válidos');
            return {
              impactMessage: parsed.impactMessage || generateFallbackImpactMessage(calculations),
              equivalencies: parsed.equivalencies || generateFallbackEquivalencies(calculations),
              categorySuggestions: parsed.categorySuggestions || [],
              motivationalMessage: parsed.motivationalMessage || '💪 ¡Pequeños cambios hacen grandes diferencias!',
              severityLevel: parsed.severityLevel || calculateSeverityLevel(calculations),
              summary: parsed.summary || `Detectamos RD$${calculations.totalAntExpenses.toLocaleString()} en gastos hormiga.`,
            };
          } else {
            console.log('[AntDetective] JSON parseado pero no tiene campos esperados:', Object.keys(parsed));
          }
        } else {
          console.log('[AntDetective] No se encontró JSON en la respuesta de Zenio');
        }
      } catch (parseError) {
        console.error('[AntDetective] Error parseando respuesta de Zenio:', parseError);
        // Log parte de la respuesta para debug
        console.log('[AntDetective] Primeros 500 chars de respuesta:', zenioResponse.message.substring(0, 500));
      }
    } else {
      console.log('[AntDetective] Zenio no retornó mensaje, zenioResponse:', zenioResponse);
    }

    // Si falla, usar fallback
    console.log('[AntDetective] Usando insights de fallback');
    return generateFallbackInsights(calculations);

  } catch (error) {
    console.error('[AntDetective] Error generando insights con Zenio:', error);
    return generateFallbackInsights(calculations);
  }
}

// =============================================
// FUNCIONES DE FALLBACK (Sin IA)
// =============================================

/**
 * Calcula el nivel de severidad basado en los datos
 */
function calculateSeverityLevel(calculations: AntExpenseCalculations): number {
  const percentage = calculations.percentageOfTotal;

  if (percentage < 10) return 1;
  if (percentage < 20) return 2;
  if (percentage < 30) return 3;
  if (percentage < 40) return 4;
  return 5;
}

/**
 * Genera mensaje de impacto de fallback
 */
function generateFallbackImpactMessage(calculations: AntExpenseCalculations): string {
  const { percentageOfTotal, totalAntExpenses, topCriminals } = calculations;
  const mainCategory = topCriminals[0]?.category || 'varios gastos pequeños';

  if (percentageOfTotal >= 30) {
    return `🚨 ¡Alerta! Tus gastos hormiga representan el ${percentageOfTotal}% de tus gastos totales. ${mainCategory} es el principal culpable con RD$${topCriminals[0]?.total.toLocaleString() || 0}.`;
  } else if (percentageOfTotal >= 20) {
    return `⚠️ Atención: El ${percentageOfTotal}% de tus gastos son "hormiga". Principalmente en ${mainCategory}. ¡Es hora de tomar acción!`;
  } else if (percentageOfTotal >= 10) {
    return `📊 Tus gastos hormiga representan el ${percentageOfTotal}% del total. ${mainCategory} lidera con RD$${topCriminals[0]?.total.toLocaleString() || 0}.`;
  }
  return `✅ Tus gastos hormiga están bajo control: solo el ${percentageOfTotal}% del total. ¡Sigue así!`;
}

/**
 * Genera equivalencias de fallback
 */
function generateFallbackEquivalencies(calculations: AntExpenseCalculations): string[] {
  const monthly = calculations.savingsOpportunityPerMonth;
  const total = calculations.totalAntExpenses;
  const equivalencies: string[] = [];

  // Equivalencias basadas en el ahorro mensual
  if (monthly >= 5000) {
    equivalencies.push(`RD$${monthly.toLocaleString()}/mes = Una suscripción de gimnasio premium`);
  }
  if (monthly >= 2000) {
    equivalencies.push(`RD$${monthly.toLocaleString()}/mes = Netflix + Spotify + Disney+ combinados`);
  }
  if (monthly >= 1000) {
    equivalencies.push(`RD$${monthly.toLocaleString()}/mes = 2 cenas en un buen restaurante`);
  }

  // Equivalencias basadas en el total del período
  if (total >= 10000) {
    equivalencies.push(`RD$${total.toLocaleString()} en ${calculations.metadata.actualMonthsAnalyzed} meses = Un vuelo de ida y vuelta nacional`);
  }
  if (total >= 5000) {
    equivalencies.push(`Con RD$${total.toLocaleString()} podrías abrir un fondo de emergencia`);
  }

  // Si no hay suficientes equivalencias
  if (equivalencies.length < 2) {
    equivalencies.push(`Ahorrando estos gastos por 1 año = RD$${(monthly * 12).toLocaleString()}`);
    equivalencies.push(`Cada RD$100 ahorrado hoy, invertido al 10% anual = RD$110 en un año`);
  }

  return equivalencies.slice(0, 4);
}

/**
 * Genera sugerencias de fallback por categoría
 */
function generateFallbackCategorySuggestions(calculations: AntExpenseCalculations): Array<{category: string; suggestions: string[]}> {
  const suggestions: Array<{category: string; suggestions: string[]}> = [];

  const categoryTips: Record<string, string[]> = {
    'Comida y restaurantes': [
      'Prepara almuerzo en casa al menos 3 días a la semana',
      'Lleva snacks saludables para evitar compras impulsivas',
      'Usa apps de delivery solo con cupones de descuento',
    ],
    'Entretenimiento': [
      'Busca alternativas gratuitas de entretenimiento',
      'Establece un presupuesto semanal para ocio',
      'Aprovecha días de descuento en cines y eventos',
    ],
    'Suscripciones': [
      'Revisa qué suscripciones realmente usas cada semana',
      'Considera planes familiares o compartidos',
      'Cancela las que no uses en los últimos 30 días',
    ],
    'Transporte': [
      'Considera usar transporte público algunos días',
      'Agrupa diligencias para hacer menos viajes',
      'Comparte viajes con compañeros de trabajo',
    ],
    'Compras': [
      'Espera 24 horas antes de compras impulsivas',
      'Haz una lista antes de ir de compras',
      'Compara precios en al menos 3 lugares',
    ],
  };

  for (const criminal of calculations.topCriminals.slice(0, 3)) {
    const tips = categoryTips[criminal.category] || [
      `Revisa si realmente necesitas todos estos gastos en ${criminal.category}`,
      'Establece un límite mensual para esta categoría',
      'Busca alternativas más económicas',
    ];

    suggestions.push({
      category: criminal.category,
      suggestions: tips,
    });
  }

  return suggestions;
}

/**
 * Genera insights completos de fallback (sin IA)
 */
function generateFallbackInsights(calculations: AntExpenseCalculations): ZenioInsights {
  return {
    impactMessage: generateFallbackImpactMessage(calculations),
    equivalencies: generateFallbackEquivalencies(calculations),
    categorySuggestions: generateFallbackCategorySuggestions(calculations),
    motivationalMessage: '💪 Recuerda: pequeños cambios en tus hábitos pueden generar grandes ahorros. ¡Tú puedes!',
    severityLevel: calculateSeverityLevel(calculations),
    summary: `Detectamos RD$${calculations.totalAntExpenses.toLocaleString()} en gastos hormiga (${calculations.percentageOfTotal}% del total).`,
  };
}

// =============================================
// ENDPOINTS
// =============================================

/**
 * GET /api/zenio/ant-expense-analysis
 * Analiza los gastos hormiga del usuario
 *
 * Restricciones por plan:
 * - FREE: Análisis básico (top 3 gastos, sin insights IA)
 * - PLUS/PRO: Análisis completo con insights IA y recomendaciones
 */
export const analyzeAntExpenses = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: 'Usuario no autenticado',
      });
    }

    // Obtener suscripción del usuario para verificar límites
    const subscription = await subscriptionService.getUserSubscription(userId);
    const planLimits = subscription.limits as any;
    const analysisType = planLimits.antExpenseAnalysis || 'basic';
    const isBasicAnalysis = analysisType === 'basic';

    console.log(`[AntDetective] Usuario ${userId}, Plan: ${subscription.plan}, Análisis: ${analysisType}`);

    // Obtener configuración de query params
    const userConfig: Partial<AntExpenseConfig> = {};

    if (req.query.antThreshold) {
      userConfig.antThreshold = parseInt(req.query.antThreshold as string);
    }
    if (req.query.minFrequency) {
      userConfig.minFrequency = parseInt(req.query.minFrequency as string);
    }
    if (req.query.monthsToAnalyze) {
      userConfig.monthsToAnalyze = parseInt(req.query.monthsToAnalyze as string);
    }

    console.log(`[AntDetective] Config recibida: ${JSON.stringify(userConfig)}`);

    // 1. Realizar cálculos
    const {
      calculations,
      warnings,
      canAnalyze,
      cannotAnalyzeReason,
    } = await antExpenseService.calculateAntExpenseStats(userId, userConfig);

    // Si no puede analizar, retornar respuesta informativa
    if (!canAnalyze || !calculations) {
      const response: AntExpenseAnalysisResponse = {
        success: true,
        canAnalyze: false,
        cannotAnalyzeReason,
        calculations: null,
        insights: null,
        warnings,
        recommendedConfig: DEFAULT_ANT_EXPENSE_CONFIG,
        configOptions: CONFIG_LIMITS,
      };

      return res.json(response);
    }

    // 2. Aplicar restricciones según el plan
    let finalCalculations = calculations;
    let insights: ZenioInsights | null = null;

    if (isBasicAnalysis) {
      // Plan FREE: Solo análisis básico (top 3 gastos)
      console.log(`[AntDetective] Aplicando restricciones de plan FREE`);

      finalCalculations = {
        ...calculations,
        // Limitar a solo 3 categorías principales
        topCriminals: calculations.topCriminals.slice(0, 3),
      };

      // Insights básicos sin IA para plan FREE
      insights = {
        impactMessage: generateFallbackImpactMessage(calculations),
        equivalencies: [], // Sin equivalencias en plan FREE
        categorySuggestions: [], // Sin sugerencias detalladas en plan FREE
        motivationalMessage: '💡 Mejora a Plus para ver el análisis completo con sugerencias personalizadas.',
        severityLevel: calculateSeverityLevel(calculations),
        summary: `Detectamos RD$${calculations.totalAntExpenses.toLocaleString()} en gastos hormiga (${calculations.percentageOfTotal}% del total).`,
      };
    } else {
      // Plan PLUS/PRO: Análisis completo con IA
      console.log(`[AntDetective] Análisis completo para plan ${subscription.plan}`);

      // Determinar si usar IA o fallback
      const useAI = req.query.useAI !== 'false'; // Por defecto usa IA

      if (useAI) {
        insights = await generateZenioInsights(calculations, userId);
      } else {
        insights = generateFallbackInsights(calculations);
      }
    }

    // 3. Construir respuesta completa
    const response: AntExpenseAnalysisResponse = {
      success: true,
      canAnalyze: true,
      calculations: finalCalculations,
      insights,
      warnings,
      recommendedConfig: DEFAULT_ANT_EXPENSE_CONFIG,
      configOptions: CONFIG_LIMITS,
      // Información adicional sobre restricciones del plan
      planInfo: {
        currentPlan: subscription.plan,
        analysisType,
        isLimited: isBasicAnalysis,
        upgradeMessage: isBasicAnalysis
          ? 'Mejora a Plus para desbloquear el análisis completo con sugerencias personalizadas por IA'
          : undefined,
      },
    };

    console.log(`[AntDetective] Análisis completado exitosamente (${analysisType})`);

    return res.json(response);

  } catch (error: any) {
    console.error('[AntDetective] Error en análisis:', error);

    return res.status(500).json({
      success: false,
      error: 'Error interno del servidor al analizar gastos hormiga',
      message: error.message,
    });
  }
};

/**
 * GET /api/zenio/ant-expense-config
 * Obtiene la configuración disponible y valores por defecto
 */
export const getAntExpenseConfig = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: 'Usuario no autenticado',
      });
    }

    // Obtener info del historial del usuario
    const userHistory = await antExpenseService.getUserHistoryInfo(userId);

    return res.json({
      success: true,
      defaultConfig: DEFAULT_ANT_EXPENSE_CONFIG,
      configOptions: CONFIG_LIMITS,
      userHistory: {
        monthsWithData: userHistory.monthsWithData,
        hasEnoughData: userHistory.hasEnoughData,
        totalExpenses: userHistory.totalExpensesInPeriod,
      },
      recommendations: {
        antThreshold: {
          value: DEFAULT_ANT_EXPENSE_CONFIG.antThreshold,
          reason: 'Montos hasta RD$500 son típicamente gastos pequeños y frecuentes',
        },
        minFrequency: {
          value: DEFAULT_ANT_EXPENSE_CONFIG.minFrequency,
          reason: 'Al menos 3 repeticiones indican un patrón de comportamiento',
        },
        monthsToAnalyze: {
          value: Math.min(DEFAULT_ANT_EXPENSE_CONFIG.monthsToAnalyze, userHistory.monthsWithData),
          reason: '3 meses permiten detectar patrones mensuales consistentes',
          maxAvailable: userHistory.monthsWithData,
        },
      },
    });

  } catch (error: any) {
    console.error('[AntDetective] Error obteniendo config:', error);

    return res.status(500).json({
      success: false,
      error: 'Error obteniendo configuración',
    });
  }
};
