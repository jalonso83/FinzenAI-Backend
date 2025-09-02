import axios from 'axios';
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

interface Transaction {
  id: number;
  amount: number;
  category: string;
  description: string | null;
  date: Date;
  type: string;
}

// Función para obtener transacciones de gastos de los últimos 3 meses
async function getRecentExpenseTransactions(userId: number): Promise<Transaction[]> {
  const threeMonthsAgo = new Date();
  threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

  const transactions = await prisma.transaction.findMany({
    where: {
      userId: userId,
      type: 'EXPENSE', // Solo gastos
      date: {
        gte: threeMonthsAgo
      }
    },
    orderBy: {
      date: 'desc'
    }
  });

  return transactions.map(t => ({
    id: t.id,
    amount: t.amount,
    category: t.category,
    description: t.description,
    date: t.date,
    type: t.type
  }));
}

// Función para preparar todas las transacciones para análisis por Zenio
function prepareTransactionsForZenio(transactions: Transaction[]): {
  transactions: Transaction[];
  totalTransactions: number;
  categoryBreakdown: Record<string, { total: number; count: number; averageAmount: number }>;
} {
  const totalTransactions = transactions.length;

  // Agrupar por categoría para resumen
  const categoryBreakdown: Record<string, { total: number; count: number; averageAmount: number }> = {};
  
  transactions.forEach(transaction => {
    if (!categoryBreakdown[transaction.category]) {
      categoryBreakdown[transaction.category] = {
        total: 0,
        count: 0,
        averageAmount: 0
      };
    }
    
    categoryBreakdown[transaction.category].total += transaction.amount;
    categoryBreakdown[transaction.category].count += 1;
  });

  // Calcular promedios
  Object.keys(categoryBreakdown).forEach(category => {
    const data = categoryBreakdown[category];
    data.averageAmount = Math.round(data.total / data.count);
  });

  return {
    transactions,
    totalTransactions,
    categoryBreakdown
  };
}

// Función para generar tendencia mensual
function generateMonthlyTrend(transactions: Transaction[]): Array<{ month: string; amount: number }> {
  const monthlyData: Record<string, number> = {};
  const monthNames = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

  transactions.forEach(t => {
    const date = new Date(t.date);
    const monthKey = `${monthNames[date.getMonth()]} ${date.getFullYear()}`;
    
    if (!monthlyData[monthKey]) {
      monthlyData[monthKey] = 0;
    }
    monthlyData[monthKey] += t.amount;
  });

  return Object.entries(monthlyData)
    .map(([month, amount]) => ({ month, amount }))
    .sort((a, b) => new Date(a.month).getTime() - new Date(b.month).getTime())
    .slice(-3); // Últimos 3 meses
}

// Función para preparar data para Zenio - análisis inteligente de gastos hormiga
function prepareDataForZenio(
  transactions: Transaction[], 
  categoryBreakdown: Record<string, { total: number; count: number; averageAmount: number }>
): string {
  const totalSpent = transactions.reduce((sum, t) => sum + t.amount, 0);
  const averageTransactionAmount = Math.round(totalSpent / transactions.length);
  
  // Obtener las 5 categorías con más gastos para que Zenio las analice
  const topCategories = Object.entries(categoryBreakdown)
    .sort(([,a], [,b]) => b.total - a.total)
    .slice(0, 5)
    .map(([category, data]) => ({
      category,
      total: data.total,
      count: data.count,
      average: data.averageAmount,
      percentage: Math.round((data.total / totalSpent) * 100)
    }));

  return `
Actúa como Detective Zenio analizando gastos hormiga. Tu misión: identificar cuáles gastos frecuentes pequeños están drenando el dinero del usuario sin que se dé cuenta.

DATOS DEL USUARIO (ÚLTIMOS 3 MESES):
- Total transacciones de gastos: ${transactions.length}
- Total gastado: $${totalSpent.toLocaleString()}
- Promedio por transacción: $${averageTransactionAmount.toLocaleString()}
- Período: últimos 3 meses

DESGLOSE POR CATEGORÍAS:
${topCategories.map((cat, i) => 
  `${i+1}. ${cat.category}: $${cat.total.toLocaleString()} (${cat.count} veces, ~$${cat.average} c/u, ${cat.percentage}% del total)`
).join('\n')}

TU TRABAJO COMO DETECTIVE ZENIO:
1. IDENTIFICA los gastos hormiga (pequeños, frecuentes, que pasan desapercibidos)
2. DETERMINA cuáles categorías son los "criminales financieros" más peligrosos
3. CALCULA el impacto real de estos gastos hormiga en el presupuesto
4. SUGIERE alternativas específicas para cada categoría problemática
5. ESTIMA cuánto podría ahorrar si controla estos gastos

RESPONDE EN TU ESTILO ZEN DETECTIVE con:
- Análisis de cuáles gastos son verdaderamente "hormiga" (basado en frecuencia + monto)
- Top 3 criminales financieros más peligrosos
- Equivalencias tangibles (qué podría comprar/lograr con ese dinero)
- Mensaje motivador pero realista sobre el impacto
- Sugerencias prácticas y específicas

NO asumas la moneda - usa la información tal como viene. El usuario puede ser de cualquier país.
`;
}

// Función para llamar al agente Zenio con la nueva función analyze_ant_expenses
async function callZenioForAntExpenseAnalysis(userId: number): Promise<string> {
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

    // 1. Obtener transacciones últimos 3 meses
    const transactions = await getRecentExpenseTransactions(userId);
    
    if (transactions.length === 0) {
      return res.json({
        totalAntExpenses: 0,
        analysisMessage: "No tienes transacciones registradas en los últimos 3 meses",
        topCriminals: [],
        monthlyTrend: [],
        equivalencies: [],
        savingsOpportunity: 0,
        zenioInsights: "¡Perfecto! No detecté gastos hormiga porque no tienes muchas transacciones registradas. Esto puede ser porque eres muy organizado o porque acabas de empezar a usar FinZen. ¡Sigue registrando tus gastos para que pueda ayudarte mejor! 🎯"
      });
    }

    // 2. Preparar todas las transacciones para análisis
    const { categoryBreakdown } = prepareTransactionsForZenio(transactions);
    
    // 3. Preparar data para Zenio
    const zenioData = prepareDataForZenio(transactions, categoryBreakdown);
    
    // 4. Llamar a Zenio REAL para análisis inteligente
    console.log('[Ant Detective] Enviando datos a Zenio para análisis...');
    const zenioInsights = await callZenioForAntExpenseAnalysis(userId);
    
    // 5. Procesar respuesta básica para el frontend (Zenio dará los insights principales)
    const totalSpent = transactions.reduce((sum, t) => sum + t.amount, 0);
    const averageTransaction = Math.round(totalSpent / transactions.length);
    
    // Detectar categorías problemáticas de manera simple como fallback para la UI
    const topCategoriesByFrequency = Object.entries(categoryBreakdown)
      .filter(([, data]) => data.count >= 5 && data.averageAmount <= averageTransaction * 0.8)
      .sort(([,a], [,b]) => b.total - a.total)
      .slice(0, 3);
    
    const estimatedAntExpenses = topCategoriesByFrequency.reduce((sum, [, data]) => sum + data.total, 0);

    // 6. Generar análisis estructurado basado en el análisis inteligente
    const topCriminals = topCategoriesByFrequency.map(([category, data], index) => ({
      category,
      amount: data.total,
      count: data.count,
      averageAmount: data.averageAmount,
      impact: `Has gastado $${data.total.toLocaleString()} en ${data.count} ocasiones`,
      suggestions: [
        `Reduce frecuencia a ${Math.max(1, Math.round(data.count * 0.5))} veces por mes`,
        `Busca alternativas más económicas`,
        `Usa presupuesto mensual para esta categoría`
      ]
    }));

    // 7. Generar equivalencias sin asumir moneda específica
    const equivalencies = estimatedAntExpenses >= totalSpent * 0.3 ? 
      ["Una inversión mensual considerable 📈"] :
      estimatedAntExpenses >= totalSpent * 0.15 ?
      ["Varias comidas en restaurantes 🍽️"] :
      ["Algunos gastos de entretenimiento 🎬"];

    // 8. Tendencia mensual basada en gastos identificados como hormiga
    const antTransactions = transactions.filter(t => 
      topCategoriesByFrequency.some(([cat]) => cat === t.category)
    );
    const monthlyTrend = generateMonthlyTrend(antTransactions);

    const result: AntExpenseAnalysis = {
      totalAntExpenses: estimatedAntExpenses,
      analysisMessage: `Detecté ${topCriminals.length} categorías con gastos hormiga en los últimos 3 meses`,
      topCriminals,
      monthlyTrend,
      equivalencies,
      savingsOpportunity: Math.round(estimatedAntExpenses * 0.3 / 3), // 30% de ahorro potencial mensual
      zenioInsights
    };

    console.log(`[Ant Detective] Analysis complete: ${topCriminals.length} ant expense categories, $${estimatedAntExpenses} total`);

    return res.json(result);

  } catch (error) {
    console.error('Error in ant expense analysis:', error);
    return res.status(500).json({ 
      error: 'Error interno del servidor al analizar gastos hormiga' 
    });
  }
};