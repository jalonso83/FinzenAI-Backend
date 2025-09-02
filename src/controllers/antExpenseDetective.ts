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

// Función para llamar al agente Zenio y capturar el tool call result
async function callZenioForAntExpenseAnalysis(userId: string): Promise<any> {
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

    console.log('[Ant Detective] Llamando al agente Zenio para análisis IA...');

    // Variable para capturar el resultado del tool call
    let toolCallResult: any = null;

    // Crear request para llamar a chatWithZenio con datos reales
    const mockReq = {
      user: { id: userId },
      body: {
        message: `Analiza mis gastos hormiga usando la función analyze_ant_expenses. Mis transacciones de los últimos 3 meses: ${JSON.stringify(transactionData)}`,
        threadId: undefined, // Crear nuevo thread para análisis
        isOnboarding: false,
        categories: [],
        timezone: 'UTC'
      }
    } as any;

    // Mock response que captura tanto el mensaje como las acciones ejecutadas
    const mockRes = {
      status: (code: number) => mockRes,
      json: (data: any) => {
        console.log('[Ant Detective] Respuesta de Zenio recibida:', data);
        
        // Si hay acciones ejecutadas, buscar el resultado del análisis
        if (data.executedActions && Array.isArray(data.executedActions)) {
          for (const action of data.executedActions) {
            if (action.action === 'analyze_ant_expenses' || 
                (action.data && action.data.totalAntExpenses !== undefined)) {
              console.log('[Ant Detective] ¡Encontrado resultado del tool call!');
              toolCallResult = action.data;
              break;
            }
          }
        }
        
        return mockRes;
      }
    } as any;

    // Importar y llamar al agente Zenio
    const { chatWithZenio } = await import('./zenio');
    await chatWithZenio(mockReq, mockRes);
    
    if (toolCallResult) {
      console.log('[Ant Detective] Análisis de Zenio IA completado exitosamente');
      return toolCallResult;
    } else {
      throw new Error('No se recibió resultado del tool call de análisis');
    }

  } catch (error) {
    console.error('[Ant Detective] Error en análisis con Zenio IA:', error);
    
    // Fallback en caso de error
    return {
      totalAntExpenses: 0,
      impactMessage: "🕵️ Detective Zenio aquí. Tuve un problema técnico, pero basándome en tus patrones de gasto, te recomiendo revisar las categorías con más transacciones frecuentes. ¡Vuelve a intentarlo en un momento! 💪",
      topCriminals: [],
      equivalencies: ["Intenta de nuevo en unos minutos"],
      savingsOpportunity: 0,
      motivationalMessage: "🚧 La función de análisis de gastos hormiga está temporalmente fuera de servicio. ¡Vuelve a intentarlo pronto!",
      insights: "Por favor contacta al soporte si el problema persiste"
    };
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

    // Llamar directamente a la función de análisis
    console.log('[Ant Detective] Ejecutando análisis directo...');
    const zenioData = await callZenioForAntExpenseAnalysis(userId);
    
    console.log('[Ant Detective] Análisis completado, formateando para frontend...');
    
    // Convertir datos al formato que espera el frontend
    const result: AntExpenseAnalysis = {
      totalAntExpenses: zenioData.totalAntExpenses || 0,
      analysisMessage: zenioData.impactMessage || "Detecté algunos gastos hormiga",
      topCriminals: (zenioData.topCriminals || []).map((criminal: any) => ({
        category: criminal.category,
        amount: criminal.amount,
        count: criminal.count,
        averageAmount: criminal.avgAmount || criminal.averageAmount,
        impact: criminal.impact,
        suggestions: criminal.recommendations || criminal.suggestions || []
      })),
      monthlyTrend: [], // Por ahora vacío, se puede llenar después
      equivalencies: zenioData.equivalencies || [],
      savingsOpportunity: zenioData.savingsOpportunity || 0,
      zenioInsights: zenioData.motivationalMessage || zenioData.insights || "Análisis completado"
    };

    console.log(`[Ant Detective] Enviando resultado al frontend:`, result);
    return res.json(result);

  } catch (error) {
    console.error('Error in ant expense analysis:', error);
    return res.status(500).json({ 
      error: 'Error interno del servidor al analizar gastos hormiga' 
    });
  }
};