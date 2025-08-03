import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

interface Alert {
  type: string;
  category: string;
  message: string;
  level: string;
}

// Obtener reporte por categorías
export const getCategoryReport = async (req: Request, res: Response): Promise<Response> => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Usuario no autenticado' });
    }

    const { 
      startDate, 
      endDate, 
      categories 
    } = req.query;

    // Configurar fechas por defecto (último mes si no se especifica)
    const now = new Date();
    const defaultStartDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const defaultEndDate = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);

    const dateStart = startDate ? new Date(startDate as string) : defaultStartDate;
    const dateEnd = endDate ? new Date(endDate as string) : defaultEndDate;

    // Filtro de categorías si se especifica
    let categoryFilter: any = {};
    if (categories) {
      const categoryIds = (categories as string).split(',').map(id => parseInt(id));
      categoryFilter = { categoryId: { in: categoryIds } };
    }

    // Obtener transacciones en el rango de fechas
    const transactions = await prisma.transaction.findMany({
      where: {
        userId,
        date: {
          gte: dateStart,
          lte: dateEnd
        },
        ...categoryFilter
      },
      include: {
        category: {
          select: {
            id: true,
            name: true,
            type: true,
            icon: true
          }
        }
      },
      orderBy: { date: 'desc' }
    });

    // Procesar datos para el reporte
    const categoryStats = new Map();
    let totalExpenses = 0;
    let totalIncome = 0;

    transactions.forEach(transaction => {
      const categoryId = transaction.category_id;
      const categoryName = transaction.category?.name || 'Sin categoría';
      const categoryType = transaction.category?.type || transaction.type;
      const amount = parseFloat(transaction.amount.toString());

      if (!categoryStats.has(categoryId)) {
        categoryStats.set(categoryId, {
          id: categoryId,
          name: categoryName,
          type: categoryType,
          icon: transaction.category?.icon,
          total: 0,
          count: 0,
          transactions: [],
          maxAmount: 0,
          minAmount: Infinity
        });
      }

      const stats = categoryStats.get(categoryId);
      stats.total += amount;
      stats.count += 1;
      stats.transactions.push({
        id: transaction.id,
        amount,
        description: transaction.description,
        date: transaction.date
      });
      stats.maxAmount = Math.max(stats.maxAmount, amount);
      stats.minAmount = Math.min(stats.minAmount, amount);

      // Calcular totales generales
      if (transaction.type === 'EXPENSE') {
        totalExpenses += amount;
      } else {
        totalIncome += amount;
      }
    });

    // Convertir Map a Array y calcular promedios
    const categoryData = Array.from(categoryStats.values()).map(stats => ({
      ...stats,
      average: stats.total / stats.count,
      percentage: totalExpenses > 0 ? (stats.total / totalExpenses) * 100 : 0,
      minAmount: stats.minAmount === Infinity ? 0 : stats.minAmount
    }));

    // Ordenar por total descendente
    categoryData.sort((a, b) => b.total - a.total);

    // Top 5 categorías
    const top5Categories = categoryData.slice(0, 5);

    // Datos para gráfico de líneas (últimos 6 meses por categoría)
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

    const monthlyData = await prisma.transaction.findMany({
      where: {
        userId,
        date: {
          gte: sixMonthsAgo,
          lte: now
        },
        ...categoryFilter
      },
      include: {
        category: true
      }
    });

    // Procesar datos mensuales
    const monthlyStats = new Map();
    monthlyData.forEach(transaction => {
      const monthKey = `${transaction.date.getFullYear()}-${String(transaction.date.getMonth() + 1).padStart(2, '0')}`;
      const categoryId = transaction.category_id;
      const amount = parseFloat(transaction.amount.toString());

      if (!monthlyStats.has(monthKey)) {
        monthlyStats.set(monthKey, new Map());
      }

      const monthData = monthlyStats.get(monthKey);
      if (!monthData.has(categoryId)) {
        monthData.set(categoryId, {
          categoryId,
          categoryName: transaction.category?.name || 'Sin categoría',
          total: 0
        });
      }

      monthData.get(categoryId).total += amount;
    });

    // Convertir a formato para gráfico
    const chartData: any[] = [];
    for (const [month, categories] of monthlyStats) {
      const monthData: any = { month };
      for (const [categoryId, data] of categories) {
        monthData[data.categoryName] = data.total;
      }
      chartData.push(monthData);
    }

    // Métricas generales
    const totalTransactions = transactions.length;
    const averageTransactionAmount = totalTransactions > 0 ? 
      (totalExpenses + totalIncome) / totalTransactions : 0;
    const maxTransaction = transactions.length > 0 ? 
      Math.max(...transactions.map(t => parseFloat(t.amount.toString()))) : 0;
    const minTransaction = transactions.length > 0 ? 
      Math.min(...transactions.map(t => parseFloat(t.amount.toString()))) : 0;

    // Generar alertas
    const alerts: Alert[] = [];
    
    // Alerta para categorías que superan el 30% del total
    categoryData.forEach(category => {
      if (category.percentage > 30) {
        alerts.push({
          type: 'high',
          category: category.name,
          message: `${category.name} representa el ${category.percentage.toFixed(1)}% del total de gastos`,
          level: 'warning'
        });
      }
    });

    // Comparar con período anterior (si es posible)
    const prevPeriodStart = new Date(dateStart);
    const prevPeriodEnd = new Date(dateEnd);
    const periodDiff = dateEnd.getTime() - dateStart.getTime();
    prevPeriodStart.setTime(prevPeriodStart.getTime() - periodDiff);
    prevPeriodEnd.setTime(prevPeriodEnd.getTime() - periodDiff);

    const previousTransactions = await prisma.transaction.findMany({
      where: {
        userId,
        date: {
          gte: prevPeriodStart,
          lte: prevPeriodEnd
        }
      },
      include: { category: true }
    });

    const prevCategoryStats = new Map();
    previousTransactions.forEach(transaction => {
      const categoryId = transaction.category_id;
      const amount = parseFloat(transaction.amount.toString());
      
      if (!prevCategoryStats.has(categoryId)) {
        prevCategoryStats.set(categoryId, 0);
      }
      prevCategoryStats.set(categoryId, prevCategoryStats.get(categoryId) + amount);
    });

    // Detectar cambios significativos
    categoryData.forEach(category => {
      const prevAmount = prevCategoryStats.get(category.id) || 0;
      if (prevAmount > 0) {
        const changePercent = ((category.total - prevAmount) / prevAmount) * 100;
        if (Math.abs(changePercent) > 50) {
          alerts.push({
            type: 'change',
            category: category.name,
            message: `${category.name} ha ${changePercent > 0 ? 'aumentado' : 'disminuido'} ${Math.abs(changePercent).toFixed(1)}% vs período anterior`,
            level: changePercent > 0 ? 'warning' : 'info'
          });
        }
      }
    });

    const reportData = {
      period: {
        startDate: dateStart,
        endDate: dateEnd
      },
      metrics: {
        totalExpenses,
        totalIncome,
        totalTransactions,
        averageTransactionAmount,
        maxTransaction,
        minTransaction,
        activeCategories: categoryData.length
      },
      categoryData,
      top5Categories,
      chartData: chartData.sort((a, b) => a.month.localeCompare(b.month)),
      alerts
    };

    return res.json(reportData);

  } catch (error) {
    console.error('Error generando reporte por categorías:', error);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
};

// Exportar datos del reporte (preparar para PDF/Excel)
export const exportCategoryReport = async (req: Request, res: Response): Promise<Response> => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Usuario no autenticado' });
    }

    const { format = 'json' } = req.query;
    
    // Reutilizar la lógica del reporte principal
    const reportResponse = await getCategoryReport(req, res);
    
    // Aquí se podría implementar la conversión a PDF/Excel
    // Por ahora devolvemos JSON
    if (format === 'json') {
      // Reutilizar la función getCategoryReport para obtener los datos
      return await getCategoryReport(req, res);
    }
    
    return res.status(501).json({ message: 'Formato de exportación no implementado aún' });
    
  } catch (error) {
    console.error('Error exportando reporte:', error);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
};