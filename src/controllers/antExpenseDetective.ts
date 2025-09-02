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
    console.log('[Ant Detective] Llamando al agente Zenio para análisis...');

    // Crear request para llamar a chatWithZenio con mensaje que active la función
    const mockReq = {
      user: { id: userId },
      body: {
        message: "Analiza mis gastos hormiga de los últimos 3 meses como Detective Zenio",
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
    const zenioInsights = await callZenioForAntExpenseAnalysis(userId);
    
    // Mock de datos para la UI mientras Zenio hace el análisis real
    const result: AntExpenseAnalysis = {
      totalAntExpenses: 0,
      analysisMessage: `Zenio está analizando tus transacciones`,
      topCriminals: [],
      monthlyTrend: [],
      equivalencies: [],
      savingsOpportunity: 0,
      zenioInsights
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