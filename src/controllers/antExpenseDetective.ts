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
    }) as any[];

    console.log('🔍 RAW TRANSACTIONS FROM DB - Total:', transactions.length);
    console.log('🔍 SAMPLE RAW TRANSACTIONS:', JSON.stringify(transactions.slice(0, 3), null, 2));

    // CREAR ARRAY LIMPIO - CON LOGS DETALLADOS
    const transactionData = [];
    
    console.log('🔍 INICIANDO MAPEO DE', transactions.length, 'TRANSACCIONES');
    
    for (let i = 0; i < transactions.length; i++) {
      const t = transactions[i];
      
      if (t && t.type === 'EXPENSE' && t.id && t.amount && t.date && t.category) {
        try {
          const cleanTransaction = {
            id: String(t.id),
            amount: Number(t.amount),
            date: new Date(t.date).toISOString(),
            category: String(t.category.name),
            type: String(t.type)
          };
          
          transactionData.push(cleanTransaction);
          console.log(`✅ Transacción ${i+1} procesada:`, cleanTransaction.id, cleanTransaction.amount, cleanTransaction.category);
          
        } catch (error) {
          console.log(`❌ Error procesando transacción ${i+1}:`, error, 'Data:', t);
        }
      } else {
        console.log(`⚠️ Transacción ${i+1} omitida - datos incompletos:`, {
          hasId: !!t?.id, 
          hasAmount: !!t?.amount, 
          hasDate: !!t?.date, 
          hasCategory: !!t?.category,
          type: t?.type
        });
      }
    }
    
    console.log('🔍 MAPEO COMPLETADO:', transactionData.length, 'transacciones válidas');

    console.log('✅ TRANSACCIONES LIMPIAS CREADAS:', transactionData.length);

    // Variable para capturar el resultado del tool call
    let toolCallResult: any = null;

    // Crear request para llamar a chatWithZenio con datos reales
    const mockReq = {
      user: { id: userId },
      body: {
        message: `Analiza mis gastos hormiga`,
        transactions: transactionData, // Solo este campo
        threadId: undefined, // Crear nuevo thread para análisis
        isOnboarding: false,
        categories: [],
        timezone: 'UTC'
      }
    } as any;

    console.log('🚀 ENVIANDO A ZENIO - transactionData length:', transactionData?.length || 0);
    console.log('🚀 ENVIANDO A ZENIO - mensaje:', mockReq.body.message);

    // Mock response que captura tanto el mensaje como las acciones ejecutadas
    const mockRes = {
      status: (code: number) => mockRes,
      json: (data: any) => {
        console.log('📥 RESPUESTA COMPLETA DE ZENIO:', JSON.stringify(data, null, 2));
        
        // Si hay acciones ejecutadas, buscar el resultado del análisis
        if (data.executedActions && Array.isArray(data.executedActions)) {
          console.log(`📋 ENCONTRADAS ${data.executedActions.length} ACCIONES EJECUTADAS`);
          
          for (const action of data.executedActions) {
            console.log(`🔍 ACCIÓN: ${action.action}`);
            
            if (action.action === 'analyze_ant_expenses') {
              toolCallResult = action.data;
              console.log('🤖 JSON RESPUESTA DE ZENIO:', JSON.stringify(toolCallResult, null, 2));
              break;
            }
          }
        } else {
          console.log('❌ NO HAY ACCIONES EJECUTADAS EN LA RESPUESTA');
        }
        
        return mockRes;
      }
    } as any;

    // Importar y llamar al agente Zenio
    const { chatWithZenio } = await import('./zenio');
    await chatWithZenio(mockReq, mockRes);
    
    if (toolCallResult) {
      return toolCallResult;
    } else {
      throw new Error('No se recibió resultado del tool call de análisis');
    }

  } catch (error) {
    console.error('[Ant Detective] Error en análisis con Zenio IA:', error);
    
    // Sin fallback directo disponible por scope de variables
    
    // Fallback final en caso de error
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

    const zenioData = await callZenioForAntExpenseAnalysis(userId);
    
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
      monthlyTrend: zenioData.monthlyTrend || [],
      equivalencies: zenioData.equivalencies || [],
      savingsOpportunity: zenioData.savingsOpportunity || 0,
      zenioInsights: zenioData.insights || zenioData.motivationalMessage || "Análisis completado"
    };

    return res.json(result);

  } catch (error) {
    console.error('Error in ant expense analysis:', error);
    return res.status(500).json({ 
      error: 'Error interno del servidor al analizar gastos hormiga' 
    });
  }
};