import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Tipos para el detective de gastos hormiga
interface AntExpenseAnalysis {
  totalAntExpenses: number;
  analysisMessage: string;
  topCriminals: Array<{
    category: string;
    amount: number;
    count: number;
    averageAmount: number;
    impact: string;
    suggestions: string[];
  }>;
  monthlyTrend: Array<{
    month: string;
    amount: number;
  }>;
  equivalencies: string[];
  savingsOpportunity: number;
  zenioInsights: string;
}

// Función para llamar al agente Zenio con la nueva función analyze_ant_expenses
async function callZenioForAntExpenseAnalysis(userId: string): Promise<string> {
  try {
    console.log('[Ant Detective] Obteniendo transacciones del usuario...');

    // Obtener transacciones de los últimos 3 meses
    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

    const transactions = await prisma.transaction.findMany({
      where: {
        userId: userId,
        date: {
          gte: threeMonthsAgo
        }
      },
      include: {
        category: true
      },
      orderBy: {
        date: 'desc'
      }
    });

    console.log(`[Ant Detective] Encontradas ${transactions.length} transacciones`);

    // Preparar datos para la función
    const transactionData = transactions.map(t => ({
      id: t.id,
      amount: t.amount,
      description: t.description,
      date: t.date.toISOString(),
      category: t.category?.name || 'Sin categoría',
      type: t.type
    }));

    console.log('[Ant Detective] Llamando al agente Zenio para análisis...');

    // Crear request para llamar a chatWithZenio con datos reales
    const mockReq = {
      user: { id: userId },
      body: {
        message: `Analiza mis gastos hormiga. Mis transacciones de los últimos 3 meses: ${JSON.stringify(transactionData)}`,
        threadId: undefined, // Crear nuevo thread para análisis
        isOnboarding: false,
        categories: [],
        timezone: 'UTC'
      }
    } as any;

    // Capturar la respuesta del agente
    let zenioResponse = '';
    
    const mockRes = {
      status: (code: number) => mockRes,
      json: (data: any) => {
        if (data.message) {
          zenioResponse = data.message;
        }
        return mockRes;
      }
    } as any;

    // Importar y llamar al agente Zenio
    const { chatWithZenio } = await import('./zenio');
    await chatWithZenio(mockReq, mockRes);
    
    if (zenioResponse) {
      console.log('[Ant Detective] Análisis de Zenio completado');
      return zenioResponse;
    } else {
      throw new Error('No se recibió respuesta del agente Zenio');
    }

  } catch (error) {
    console.error('[Ant Detective] Error en análisis con Zenio:', error);
    
    // Fallback en caso de error
    return `🕵️ Detective Zenio aquí. Tuve un problema técnico, pero basándome en tus patrones de gasto, te recomiendo revisar las categorías con más transacciones frecuentes. ¡Vuelve a intentarlo en un momento! 💪`;
  }
}

// Endpoint principal para análisis de gastos hormiga
export const analyzeAntExpenses = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    
    if (!userId) {
      return res.status(401).json({ error: 'Usuario no autenticado' });
    }

    console.log(`[Ant Detective] Starting analysis for user ${userId}`);

    // Llamar a Zenio REAL para análisis inteligente
    console.log('[Ant Detective] Enviando datos a Zenio para análisis...');
    const zenioResponse = await callZenioForAntExpenseAnalysis(userId);
    
    // Log de la respuesta cruda para debugging
    console.log('[Ant Detective] Respuesta cruda de Zenio:', zenioResponse);
    console.log('[Ant Detective] Tipo de respuesta:', typeof zenioResponse);
    console.log('[Ant Detective] Longitud de respuesta:', zenioResponse.length);
    
    // Parsear la respuesta JSON de Zenio
    let zenioData;
    try {
      zenioData = JSON.parse(zenioResponse);
      console.log('[Ant Detective] JSON parseado correctamente de Zenio');
    } catch (error) {
      console.error('[Ant Detective] Error parseando JSON de Zenio:', error);
      console.log('[Ant Detective] Primeros 200 caracteres de la respuesta:', zenioResponse.substring(0, 200));
      // Fallback si Zenio no devuelve JSON válido
      zenioData = {
        totalAntExpenses: 0,
        impactMessage: "🕵️ Detective Zenio está teniendo problemas técnicos",
        topCriminals: [],
        equivalencies: ["Intenta de nuevo en unos minutos"],
        savingsOpportunity: 0,
        motivationalMessage: "🚧 La función de análisis de gastos hormiga está temporalmente fuera de servicio. ¡Vuelve a intentarlo pronto!",
        insights: "Por favor contacta al soporte si el problema persiste"
      };
    }
    
    // Convertir datos de Zenio al formato que espera el frontend
    const result: AntExpenseAnalysis = {
      totalAntExpenses: zenioData.totalAntExpenses || 0,
      analysisMessage: zenioData.impactMessage || "Detecté algunos gastos hormiga",
      topCriminals: (zenioData.topCriminals || []).map((criminal: any) => ({
        category: criminal.category,
        amount: criminal.amount,
        count: criminal.count,
        averageAmount: criminal.avgAmount,
        impact: criminal.impact,
        suggestions: criminal.recommendations || []
      })),
      monthlyTrend: [], // Por ahora vacío, lo llenaremos después
      equivalencies: zenioData.equivalencies || [],
      savingsOpportunity: zenioData.monthlyPotentialSavings || 0,
      zenioInsights: zenioData.motivationalMessage || zenioData.insights || "Análisis completado"
    };

    console.log(`[Ant Detective] Analysis complete`);
    return res.json(result);

  } catch (error) {
    console.error('Error in ant expense analysis:', error);
    return res.status(500).json({ 
      error: 'Error interno del servidor al analizar gastos hormiga' 
    });
  }
};