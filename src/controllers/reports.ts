import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';

import { logger } from '../utils/logger';
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

    // Configurar fechas por defecto (mes actual si no se especifica)
    const now = new Date();
    const defaultStartDate = new Date(now.getFullYear(), now.getMonth(), 1);
    const defaultEndDate = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

    const dateStart = startDate ? new Date(startDate as string) : defaultStartDate;
    const dateEnd = endDate ? new Date(endDate as string) : defaultEndDate;

    // Filtro de categorías si se especifica
    let categoryFilter: any = {};
    if (categories) {
      const categoryIds = (categories as string).split(',').filter(id => id.trim() !== '');
      if (categoryIds.length > 0) {
        categoryFilter = { category_id: { in: categoryIds } };
      }
    }

    // Obtener transacciones en el rango de fechas - SOLO GASTOS
    const transactions = await prisma.transaction.findMany({
      where: {
        userId,
        date: {
          gte: dateStart,
          lte: dateEnd
        },
        type: 'EXPENSE',  // Solo gastos para el reporte de categorías
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

    // Procesar datos para el reporte - SOLO GASTOS
    const categoryStats = new Map();
    let totalExpenses = 0;

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

      // Solo gastos
      totalExpenses += amount;
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

    // Datos para gráfico de líneas (últimos 3 meses por categoría)
    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

    const monthlyData = await prisma.transaction.findMany({
      where: {
        userId,
        date: {
          gte: dateStart,
          lte: dateEnd
        },
        type: 'EXPENSE',  // Solo gastos para el gráfico
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

    // Métricas generales - SOLO GASTOS
    const totalTransactions = transactions.length;
    const averageTransactionAmount = totalTransactions > 0 ? 
      totalExpenses / totalTransactions : 0;
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

    // Período anterior robusto: mes calendario previo si el rango es un mes completo
    // (dashboard móvil), o ventana de igual duración si es un rango libre (panel web).
    const { prevPeriodStart, prevPeriodEnd } = getPreviousPeriod(dateStart, dateEnd);

    const previousTransactions = await prisma.transaction.findMany({
      where: {
        userId,
        date: {
          gte: prevPeriodStart,
          lte: prevPeriodEnd
        },
        type: 'EXPENSE'  // Solo gastos para comparación
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
        totalIncome: 0, // Para compatibilidad con frontend
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
    logger.error('Error generando reporte por categorías:', error);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
};

// Exportar datos del reporte
export const exportCategoryReport = async (req: Request, res: Response): Promise<Response> => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Usuario no autenticado' });
    }

    const { format = 'json' } = req.query;
    
    // Obtener los datos del reporte
    const { 
      startDate, 
      endDate, 
      categories 
    } = req.query;

    // Configurar fechas por defecto
    const now = new Date();
    const defaultStartDate = new Date(now.getFullYear(), now.getMonth(), 1);
    const defaultEndDate = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

    const dateStart = startDate ? new Date(startDate as string) : defaultStartDate;
    const dateEnd = endDate ? new Date(endDate as string) : defaultEndDate;

    // Filtro de categorías si se especifica
    let categoryFilter: any = {};
    if (categories) {
      const categoryIds = (categories as string).split(',').filter(id => id.trim() !== '');
      if (categoryIds.length > 0) {
        categoryFilter = { category_id: { in: categoryIds } };
      }
    }

    // Obtener datos para exportación - SOLO GASTOS
    const transactions = await prisma.transaction.findMany({
      where: {
        userId,
        date: {
          gte: dateStart,
          lte: dateEnd
        },
        type: 'EXPENSE',  // Solo gastos para exportación
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

    // Procesar datos para exportación - SOLO GASTOS
    const categoryStats = new Map();
    let totalExpenses = 0;

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
          maxAmount: 0,
          minAmount: Infinity
        });
      }

      const stats = categoryStats.get(categoryId);
      stats.total += amount;
      stats.count += 1;
      stats.maxAmount = Math.max(stats.maxAmount, amount);
      stats.minAmount = Math.min(stats.minAmount, amount);

      // Solo gastos
      totalExpenses += amount;
    });

    const categoryData = Array.from(categoryStats.values()).map(stats => ({
      ...stats,
      average: stats.total / stats.count,
      percentage: totalExpenses > 0 ? (stats.total / totalExpenses) * 100 : 0,
      minAmount: stats.minAmount === Infinity ? 0 : stats.minAmount
    }));

    categoryData.sort((a, b) => b.total - a.total);

    if (format === 'csv') {
      // Crear CSV para Excel
      const csvHeaders = [
        'Categoría de Gasto',
        'Total Gastado (DOP)',
        'Cantidad Transacciones',
        'Promedio (DOP)',
        'Máximo (DOP)',
        'Mínimo (DOP)',
        'Porcentaje del Total (%)'
      ];

      const csvRows = categoryData.map(cat => [
        cat.name,
        cat.total.toFixed(2),
        cat.count.toString(),
        cat.average.toFixed(2),
        cat.maxAmount.toFixed(2),
        cat.minAmount.toFixed(2),
        cat.percentage.toFixed(1)
      ]);

      const csvContent = [csvHeaders, ...csvRows]
        .map(row => row.map(field => `"${field}"`).join(','))
        .join('\n');

      const fileName = `reporte-categorias-${dateStart.toISOString().split('T')[0]}-${dateEnd.toISOString().split('T')[0]}.csv`;

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      res.setHeader('Cache-Control', 'no-cache');
      
      return res.send('\ufeff' + csvContent); // BOM para UTF-8
    }

    if (format === 'json') {
      // Devolver datos estructurados para que el frontend los procese
      const exportData = {
        metadata: {
          title: 'Reporte por Categorías',
          dateRange: {
            start: dateStart.toISOString().split('T')[0],
            end: dateEnd.toISOString().split('T')[0]
          },
          generatedAt: new Date().toISOString(),
          totalTransactions: transactions.length,
          totalExpenses
        },
        summary: {
          totalExpenses,
          totalTransactions: transactions.length,
          activeCategories: categoryData.length
        },
        categoryData,
        transactions: transactions.map(t => ({
          id: t.id,
          date: t.date,
          description: t.description,
          amount: parseFloat(t.amount.toString()),
          type: t.type,
          category: t.category?.name || 'Sin categoría'
        }))
      };

      return res.json(exportData);
    }
    
    return res.status(400).json({ message: 'Formato no soportado. Use: csv o json' });
    
  } catch (error) {
    logger.error('Error exportando reporte:', error);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
};

// Obtener reporte por categorías de INGRESOS
export const getIncomeReport = async (req: Request, res: Response): Promise<Response> => {
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

    // Configurar fechas por defecto (mes actual si no se especifica)
    const now = new Date();
    const defaultStartDate = new Date(now.getFullYear(), now.getMonth(), 1);
    const defaultEndDate = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

    const dateStart = startDate ? new Date(startDate as string) : defaultStartDate;
    const dateEnd = endDate ? new Date(endDate as string) : defaultEndDate;

    // Filtro de categorías si se especifica
    let categoryFilter: any = {};
    if (categories) {
      const categoryIds = (categories as string).split(',').filter(id => id.trim() !== '');
      if (categoryIds.length > 0) {
        categoryFilter = { category_id: { in: categoryIds } };
      }
    }

    // Obtener transacciones en el rango de fechas - SOLO INGRESOS
    const transactions = await prisma.transaction.findMany({
      where: {
        userId,
        date: {
          gte: dateStart,
          lte: dateEnd
        },
        type: 'INCOME',  // Solo ingresos para el reporte de categorías de ingresos
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

    // Procesar datos para el reporte - SOLO INGRESOS
    const categoryStats = new Map();
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

      // Solo ingresos
      totalIncome += amount;
    });

    // Convertir Map a Array y calcular promedios
    const categoryData = Array.from(categoryStats.values()).map(stats => ({
      ...stats,
      average: stats.total / stats.count,
      percentage: totalIncome > 0 ? (stats.total / totalIncome) * 100 : 0,
      minAmount: stats.minAmount === Infinity ? 0 : stats.minAmount
    }));

    // Ordenar por total descendente
    categoryData.sort((a, b) => b.total - a.total);

    // Top 5 categorías
    const top5Categories = categoryData.slice(0, 5);

    // Datos para gráfico de líneas (últimos 3 meses por categoría)
    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

    const monthlyData = await prisma.transaction.findMany({
      where: {
        userId,
        date: {
          gte: dateStart,
          lte: dateEnd
        },
        type: 'INCOME',  // Solo ingresos para el gráfico
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

    // Métricas generales - SOLO INGRESOS
    const totalTransactions = transactions.length;
    const averageTransactionAmount = totalTransactions > 0 ? 
      totalIncome / totalTransactions : 0;
    const maxTransaction = transactions.length > 0 ? 
      Math.max(...transactions.map(t => parseFloat(t.amount.toString()))) : 0;
    const minTransaction = transactions.length > 0 ? 
      Math.min(...transactions.map(t => parseFloat(t.amount.toString()))) : 0;

    // Generar alertas
    const alerts: Alert[] = [];
    
    // Alerta para categorías que superan el 40% del total de ingresos
    categoryData.forEach(category => {
      if (category.percentage > 40) {
        alerts.push({
          type: 'high',
          category: category.name,
          message: `${category.name} representa el ${category.percentage.toFixed(1)}% del total de ingresos`,
          level: 'warning'
        });
      }
    });

    // Período anterior robusto: mes calendario previo si el rango es un mes completo
    // (dashboard móvil), o ventana de igual duración si es un rango libre (panel web).
    const { prevPeriodStart, prevPeriodEnd } = getPreviousPeriod(dateStart, dateEnd);

    const previousTransactions = await prisma.transaction.findMany({
      where: {
        userId,
        date: {
          gte: prevPeriodStart,
          lte: prevPeriodEnd
        },
        type: 'INCOME'  // Solo ingresos para comparación
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
            level: changePercent > 0 ? 'info' : 'warning'
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
        totalExpenses: 0, // Para compatibilidad con frontend
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
    logger.error('Error generando reporte de ingresos por categorías:', error);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
};

// Obtener reporte por fechas - Análisis temporal
export const getDateReport = async (req: Request, res: Response): Promise<Response> => {
  try {
    
    const userId = req.user?.id;
    if (!userId) {
      logger.log('[Reports] Usuario no autenticado');
      return res.status(401).json({ message: 'Usuario no autenticado' });
    }

    const { 
      startDate, 
      endDate, 
      granularity = 'weekly',
      transactionType = 'both' 
    } = req.query;

    // Configurar fechas por defecto (último mes)
    const now = new Date();
    const defaultStartDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const defaultEndDate = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);

    const dateStart = startDate ? new Date(startDate as string) : defaultStartDate;
    const dateEnd = endDate ? new Date(endDate as string) : defaultEndDate;

    // Filtro de tipo de transacción
    let typeFilter: any = {};
    if (transactionType === 'expenses') {
      typeFilter = { type: 'EXPENSE' };
    } else if (transactionType === 'income') {
      typeFilter = { type: 'INCOME' };
    }

    // Obtener todas las transacciones del período
    const transactions = await prisma.transaction.findMany({
      where: {
        userId,
        date: {
          gte: dateStart,
          lte: dateEnd
        },
        ...typeFilter
      },
      include: {
        category: {
          select: {
            name: true,
            type: true,
            icon: true
          }
        }
      },
      orderBy: { date: 'asc' }
    });

    // Calcular métricas básicas
    let totalExpenses = 0;
    let totalIncome = 0;
    const transactionsByDay = new Map();
    const amountsByDay = new Map();

    transactions.forEach(transaction => {
      const amount = parseFloat(transaction.amount.toString());
      const dayKey = transaction.date.toISOString().split('T')[0];

      if (transaction.type === 'EXPENSE') {
        totalExpenses += amount;
      } else {
        totalIncome += amount;
      }

      // Agrupar por día para análisis temporal
      if (!transactionsByDay.has(dayKey)) {
        transactionsByDay.set(dayKey, []);
        amountsByDay.set(dayKey, { expenses: 0, income: 0, count: 0 });
      }

      transactionsByDay.get(dayKey).push(transaction);
      const dayData = amountsByDay.get(dayKey);
      dayData.count += 1;

      if (transaction.type === 'EXPENSE') {
        dayData.expenses += amount;
      } else {
        dayData.income += amount;
      }
    });

    const totalTransactions = transactions.length;
    const balanceNet = totalIncome - totalExpenses;
    const averageTicket = totalTransactions > 0 ? (totalExpenses + totalIncome) / totalTransactions : 0;

    // Análisis temporal según granularidad
    const timeSeriesData = generateTimeSeries(transactions, granularity as string, dateStart, dateEnd);

    // Período anterior robusto: mes calendario previo si el rango es un mes completo
    // (dashboard móvil, p.ej. julio → junio 1-30), o ventana de igual duración si es un
    // rango libre (presets del panel web). Antes se restaba la duración en ms del mes
    // actual, lo que desalineaba el mes previo (julio daba "31 may → 30 jun").
    const { prevPeriodStart, prevPeriodEnd } = getPreviousPeriod(dateStart, dateEnd);

    const previousTransactions = await prisma.transaction.findMany({
      where: {
        userId,
        date: {
          gte: prevPeriodStart,
          lte: prevPeriodEnd
        },
        ...typeFilter
      }
    });

    const prevTotalExpenses = previousTransactions
      .filter(t => t.type === 'EXPENSE')
      .reduce((sum, t) => sum + parseFloat(t.amount.toString()), 0);
    
    const prevTotalIncome = previousTransactions
      .filter(t => t.type === 'INCOME')
      .reduce((sum, t) => sum + parseFloat(t.amount.toString()), 0);

    // Cálculo de tendencias
    const expensesGrowth = prevTotalExpenses > 0 ? ((totalExpenses - prevTotalExpenses) / prevTotalExpenses) * 100 : 0;
    const incomeGrowth = prevTotalIncome > 0 ? ((totalIncome - prevTotalIncome) / prevTotalIncome) * 100 : 0;
    const balanceGrowth = prevTotalIncome - prevTotalExpenses !== 0 ? 
      ((balanceNet - (prevTotalIncome - prevTotalExpenses)) / Math.abs(prevTotalIncome - prevTotalExpenses)) * 100 : 0;

    // Análisis de patrones
    const dailyAmounts = Array.from(amountsByDay.values()).map(day => day.expenses + day.income);
    const avgDailyAmount = dailyAmounts.length > 0 ? dailyAmounts.reduce((a, b) => a + b, 0) / dailyAmounts.length : 0;

    // Volatilidad (desviación estándar) sobre TODOS los días del período, incluidos los
    // días en 0. Antes se calculaba solo sobre los días con transacciones, lo que
    // subestimaba/distorsionaba la volatilidad que alimenta el Vibe.
    const totalDaysInPeriod = Math.max(1, Math.ceil((dateEnd.getTime() - dateStart.getTime()) / (1000 * 60 * 60 * 24)));
    const dailyAmountsZeroFilled = [
      ...dailyAmounts,
      ...Array(Math.max(0, totalDaysInPeriod - dailyAmounts.length)).fill(0),
    ];
    const volMean = dailyAmountsZeroFilled.reduce((a, b) => a + b, 0) / dailyAmountsZeroFilled.length;
    const variance = dailyAmountsZeroFilled.reduce((sum, amount) => sum + Math.pow(amount - volMean, 2), 0) / dailyAmountsZeroFilled.length;
    const volatility = Math.sqrt(variance);

    // Días más activos
    const dayActivity = Array.from(amountsByDay.entries())
      .map(([date, data]) => ({ date, ...data, total: data.expenses + data.income }))
      .sort((a, b) => b.total - a.total);

    const mostActiveDay = dayActivity[0] || null;
    const highestExpenseDay = dayActivity
      .sort((a, b) => b.expenses - a.expenses)[0] || null;
    const highestIncomeDay = dayActivity
      .sort((a, b) => b.income - a.income)[0] || null;

    // Generar alertas
    const alerts: Alert[] = [];
    
    // Alerta por picos de gastos
    if (mostActiveDay && mostActiveDay.total > avgDailyAmount * 1.5) {
      alerts.push({
        type: 'peak',
        category: 'Análisis Temporal',
        message: `Pico de actividad detectado el ${new Date(mostActiveDay.date).toLocaleDateString('es-DO')} (${((mostActiveDay.total / avgDailyAmount - 1) * 100).toFixed(0)}% sobre el promedio)`,
        level: 'warning'
      });
    }

    // Alerta por tendencia de gastos
    if (expensesGrowth > 20) {
      alerts.push({
        type: 'trend',
        category: 'Gastos',
        message: `Los gastos han aumentado ${expensesGrowth.toFixed(1)}% vs el período anterior`,
        level: 'warning'
      });
    }

    // Alerta por días inactivos
    const totalDays = Math.ceil((dateEnd.getTime() - dateStart.getTime()) / (1000 * 60 * 60 * 24));
    const activeDays = amountsByDay.size;
    const inactiveDays = totalDays - activeDays;
    
    if (inactiveDays > totalDays * 0.3) {
      alerts.push({
        type: 'inactivity',
        category: 'Comportamiento',
        message: `${inactiveDays} días sin transacciones en el período (${((inactiveDays/totalDays)*100).toFixed(0)}% del tiempo)`,
        level: 'info'
      });
    }

    // Burn rate = gasto promedio por día TRANSCURRIDO del mes (no dividido por el largo
    // completo del período). A principio de mes, con pocos días corridos, esto evita el
    // número irreal que daba antes. Para un mes ya cerrado usa el mes completo.
    const elapsedMs = Math.min(dateEnd.getTime(), now.getTime()) - dateStart.getTime();
    const elapsedDays = Math.max(1, Math.ceil(elapsedMs / (1000 * 60 * 60 * 24)));
    const burnRate = totalExpenses / elapsedDays;

    // Runway = BALANCE REAL ACUMULADO (ingresos−gastos de TODA la vida del usuario), no
    // el neto del mes. Es el mismo dinero que muestra el card de balance del dashboard,
    // así el Vibe deja de saltar cada mes ignorando lo que el usuario realmente tiene.
    const lifetimeAgg = await prisma.transaction.groupBy({
      by: ['type'],
      where: { userId },
      _sum: { amount: true },
    });
    let lifetimeIncome = 0;
    let lifetimeExpenses = 0;
    for (const row of lifetimeAgg) {
      const sum = Number(row._sum.amount ?? 0);
      if (row.type === 'INCOME') lifetimeIncome = sum;
      else if (row.type === 'EXPENSE') lifetimeExpenses = sum;
    }
    const realBalance = lifetimeIncome - lifetimeExpenses;
    const runway = (burnRate > 0 && realBalance > 0) ? Math.ceil(realBalance / burnRate) : 0;
    

    // Heatmap data (actividad por día de la semana)
    const weekdayActivity = [0, 0, 0, 0, 0, 0, 0]; // Dom, Lun, Mar, Mie, Jue, Vie, Sab
    transactions.forEach(transaction => {
      const dayOfWeek = transaction.date.getDay();
      weekdayActivity[dayOfWeek] += parseFloat(transaction.amount.toString());
    });

    const reportData = {
      period: {
        startDate: dateStart,
        endDate: dateEnd,
        granularity,
        transactionType
      },
      metrics: {
        totalExpenses,
        totalIncome,
        balanceNet,
        totalTransactions,
        averageTicket,
        expensesGrowth,
        incomeGrowth,
        balanceGrowth,
        avgDailyAmount,
        volatility,
        burnRate,
        runway: runway > 0 ? runway : null,
        activeDays,
        inactiveDays
      },
      patterns: {
        // La fecha (dayKey 'YYYY-MM-DD') se manda con hora a MEDIODÍA UTC. Así la app,
        // que hace new Date(str), no la interpreta como medianoche UTC (que en RD/UTC-4
        // mostraría el día ANTERIOR, p.ej. "30 jun" para el 1 jul). Con mediodía UTC el
        // día local sale correcto en cualquier huso del continente.
        mostActiveDay: mostActiveDay ? {
          date: mostActiveDay.date + 'T12:00:00.000Z',
          total: mostActiveDay.total,
          transactions: mostActiveDay.count
        } : null,
        highestExpenseDay: highestExpenseDay ? {
          date: highestExpenseDay.date + 'T12:00:00.000Z',
          amount: highestExpenseDay.expenses
        } : null,
        highestIncomeDay: highestIncomeDay ? {
          date: highestIncomeDay.date + 'T12:00:00.000Z',
          amount: highestIncomeDay.income
        } : null,
        weekdayActivity
      },
      timeSeriesData,
      alerts
    };

    return res.json(reportData);

  } catch (error) {
    logger.error('Error generando reporte por fechas:', error);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
};

/**
 * Período anterior para comparar tendencias.
 * - Si el rango es un MES calendario completo (caso del dashboard móvil), devuelve el mes
 *   calendario inmediatamente anterior. Los meses miden distinto (28-31 días), así que
 *   restar la duración en ms desalineaba el mes previo y torcía todas las tendencias.
 * - Si es un rango arbitrario / multi-mes (presets del panel web: 3 meses, año, custom),
 *   devuelve la ventana de IGUAL duración inmediatamente anterior (lo correcto ahí).
 * Detección independiente del timezone del servidor: el rango mensual siempre empieza el
 * día 1 (UTC) y dura ~un mes; los rangos libres empiezan otro día o duran más.
 */
function getPreviousPeriod(dateStart: Date, dateEnd: Date): { prevPeriodStart: Date; prevPeriodEnd: Date } {
  const daysSpan = (dateEnd.getTime() - dateStart.getTime()) / (1000 * 60 * 60 * 24);
  const isSingleMonth = dateStart.getUTCDate() === 1 && daysSpan >= 27 && daysSpan <= 31.5;

  if (isSingleMonth) {
    const y = dateStart.getUTCFullYear();
    const m = dateStart.getUTCMonth();
    return {
      prevPeriodStart: new Date(Date.UTC(y, m - 1, 1, 0, 0, 0)),
      prevPeriodEnd: new Date(Date.UTC(y, m, 0, 23, 59, 59)),
    };
  }

  const periodDiff = dateEnd.getTime() - dateStart.getTime();
  return {
    prevPeriodStart: new Date(dateStart.getTime() - periodDiff),
    prevPeriodEnd: new Date(dateEnd.getTime() - periodDiff),
  };
}

// Función auxiliar para generar series temporales
function generateTimeSeries(transactions: any[], granularity: string, startDate: Date, endDate: Date) {
  const series: any[] = [];
  const groupedData = new Map();

  transactions.forEach(transaction => {
    let periodKey: string;
    const transDate = new Date(transaction.date);
    
    switch (granularity) {
      case 'daily':
        periodKey = transDate.toISOString().split('T')[0];
        break;
      case 'weekly':
        const weekStart = new Date(transDate);
        weekStart.setDate(transDate.getDate() - transDate.getDay());
        periodKey = weekStart.toISOString().split('T')[0];
        break;
      case 'monthly':
        periodKey = `${transDate.getFullYear()}-${String(transDate.getMonth() + 1).padStart(2, '0')}`;
        break;
      default:
        periodKey = transDate.toISOString().split('T')[0];
    }

    if (!groupedData.has(periodKey)) {
      groupedData.set(periodKey, {
        period: periodKey,
        expenses: 0,
        income: 0,
        transactions: 0,
        balance: 0
      });
    }

    const group = groupedData.get(periodKey);
    const amount = parseFloat(transaction.amount.toString());
    
    if (transaction.type === 'EXPENSE') {
      group.expenses += amount;
    } else {
      group.income += amount;
    }
    
    group.transactions += 1;
    group.balance = group.income - group.expenses;
  });

  // Convertir Map a Array y ordenar
  return Array.from(groupedData.values()).sort((a, b) => a.period.localeCompare(b.period));
}

// Obtener totales para dashboard - Métricas principales sin filtros de fecha
export const getDashboardTotals = async (req: Request, res: Response): Promise<Response> => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Usuario no autenticado' });
    }

    // Obtener TODAS las transacciones del usuario sin límite de fechas
    const allTransactions = await prisma.transaction.findMany({
      where: { userId },
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

    // Calcular totales históricos completos
    let totalIncome = 0;
    let totalExpenses = 0;
    let totalTransactions = allTransactions.length;

    // Procesar todas las transacciones para obtener totales reales
    allTransactions.forEach(transaction => {
      const amount = parseFloat(transaction.amount.toString());
      if (transaction.type === 'INCOME') {
        totalIncome += amount;
      } else {
        totalExpenses += amount;
      }
    });

    const totalBalance = totalIncome - totalExpenses;

    // Calcular totales del mes actual para comparación
    const now = new Date();
    const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const currentMonthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

    const currentMonthTransactions = allTransactions.filter(t => {
      const transactionDate = new Date(t.date);
      return transactionDate >= currentMonthStart && transactionDate <= currentMonthEnd;
    });

    let monthlyIncome = 0;
    let monthlyExpenses = 0;

    currentMonthTransactions.forEach(transaction => {
      const amount = parseFloat(transaction.amount.toString());
      if (transaction.type === 'INCOME') {
        monthlyIncome += amount;
      } else {
        monthlyExpenses += amount;
      }
    });

    const monthlyBalance = monthlyIncome - monthlyExpenses;

    // Análisis de gastos por categoría (para el gráfico)
    const expenseTransactions = allTransactions.filter(t => t.type === 'EXPENSE');
    const categoryTotals: { [key: string]: number } = {};
    
    expenseTransactions.forEach(transaction => {
      const categoryId = transaction.category_id;
      if (categoryId) {
        categoryTotals[categoryId] = (categoryTotals[categoryId] || 0) + parseFloat(transaction.amount.toString());
      }
    });

    // Top categorías de gastos
    const topExpenseCategories = Object.entries(categoryTotals)
      .map(([categoryId, total]) => {
        const category = allTransactions.find(t => t.category_id === categoryId)?.category;
        return {
          id: categoryId,
          name: category?.name || 'Sin categoría',
          icon: category?.icon || '📊',
          total: total,
          percentage: totalExpenses > 0 ? (total / totalExpenses) * 100 : 0
        };
      })
      .sort((a, b) => b.total - a.total)
      .slice(0, 8);

    return res.json({
      totals: {
        totalIncome,
        totalExpenses,
        totalBalance,
        totalTransactions,
        monthlyIncome,
        monthlyExpenses,
        monthlyBalance,
        monthlyTransactions: currentMonthTransactions.length
      },
      topExpenseCategories,
      recentTransactions: allTransactions.slice(0, 10),
      period: {
        start: currentMonthStart,
        end: currentMonthEnd
      }
    });

  } catch (error) {
    logger.error('Error obteniendo totales del dashboard:', error);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
};

// Obtener reporte de presupuestos - Análisis de rendimiento
export const getBudgetReport = async (req: Request, res: Response): Promise<Response> => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Usuario no autenticado' });
    }

    const { 
      startDate, 
      endDate, 
      categories,
      activeOnly = 'true' 
    } = req.query;

    // Configurar fechas por defecto (mes actual)
    const now = new Date();
    const defaultStartDate = new Date(now.getFullYear(), now.getMonth(), 1);
    const defaultEndDate = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

    const dateStart = startDate ? new Date(startDate as string) : defaultStartDate;
    const dateEnd = endDate ? new Date(endDate as string) : defaultEndDate;

    // Filtro de categorías si se especifica
    let categoryFilter: any = {};
    if (categories) {
      const categoryIds = (categories as string).split(',').filter(id => id.trim() !== '');
      if (categoryIds.length > 0) {
        categoryFilter = { category_id: { in: categoryIds } };
      }
    }

    // Filtro de presupuestos activos
    let activeFilter: any = {};
    if (activeOnly === 'true') {
      activeFilter = { is_active: true };
    }

    // Obtener presupuestos del período
    const budgets = await prisma.budget.findMany({
      where: {
        user_id: userId,
        start_date: { lte: dateEnd },
        end_date: { gte: dateStart },
        ...categoryFilter,
        ...activeFilter
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
      orderBy: { created_at: 'desc' }
    });

    // Obtener transacciones relacionadas con los presupuestos
    const budgetCategoryIds = budgets.map(b => b.category_id);
    const transactions = await prisma.transaction.findMany({
      where: {
        userId,
        category_id: { in: budgetCategoryIds },
        date: { gte: dateStart, lte: dateEnd },
        type: 'EXPENSE'
      },
      include: { category: true },
      orderBy: { date: 'desc' }
    });

    // Procesar datos de presupuestos
    const budgetStats = budgets.map(budget => {
      const budgetAmount = parseFloat(budget.amount.toString());
      
      // Calcular gastos en este presupuesto
      const budgetTransactions = transactions.filter(t => t.category_id === budget.category_id);
      const totalSpent = budgetTransactions.reduce((sum, t) => sum + parseFloat(t.amount.toString()), 0);
      
      // Calcular métricas
      const percentageUsed = budgetAmount > 0 ? (totalSpent / budgetAmount) * 100 : 0;
      const remaining = Math.max(0, budgetAmount - totalSpent);
      const isExceeded = totalSpent > budgetAmount;
      
      // Calcular días transcurridos y restantes
      const budgetStart = new Date(budget.start_date);
      const budgetEnd = new Date(budget.end_date);
      const totalDays = Math.ceil((budgetEnd.getTime() - budgetStart.getTime()) / (1000 * 60 * 60 * 24));
      const elapsedDays = Math.ceil((now.getTime() - budgetStart.getTime()) / (1000 * 60 * 60 * 24));
      const remainingDays = Math.max(0, totalDays - elapsedDays);
      
      // Velocidad de gasto (DOP/día)
      const plannedDailySpend = totalDays > 0 ? budgetAmount / totalDays : 0;
      const actualDailySpend = elapsedDays > 0 ? totalSpent / elapsedDays : 0;
      const spendVelocity = plannedDailySpend > 0 ? (actualDailySpend / plannedDailySpend) * 100 : 0;
      
      // Proyección de fin de período
      const projectedTotal = remainingDays > 0 ? totalSpent + (actualDailySpend * remainingDays) : totalSpent;
      const projectedExcess = Math.max(0, projectedTotal - budgetAmount);
      
      // Estado del presupuesto
      let status = 'on_track';
      if (isExceeded) {
        status = 'exceeded';
      } else if (percentageUsed > 90) {
        status = 'critical';
      } else if (percentageUsed > 75) {
        status = 'warning';
      }

      return {
        id: budget.id,
        name: budget.name,
        category: budget.category,
        period: budget.period,
        budgetAmount,
        totalSpent,
        remaining,
        percentageUsed,
        isExceeded,
        status,
        totalDays,
        elapsedDays,
        remainingDays,
        plannedDailySpend,
        actualDailySpend,
        spendVelocity,
        projectedTotal,
        projectedExcess,
        alertPercentage: budget.alert_percentage,
        isActive: budget.is_active,
        startDate: budget.start_date,
        endDate: budget.end_date,
        transactionCount: budgetTransactions.length
      };
    });

    // Métricas generales
    const totalBudgetsActive = budgetStats.filter(b => b.isActive).length;
    const totalBudgeted = budgetStats.reduce((sum, b) => sum + b.budgetAmount, 0);
    const totalSpent = budgetStats.reduce((sum, b) => sum + b.totalSpent, 0);
    const totalRemaining = budgetStats.reduce((sum, b) => sum + b.remaining, 0);
    
    // Tasa de cumplimiento
    const budgetsOnTrack = budgetStats.filter(b => b.status === 'on_track').length;
    const complianceRate = budgets.length > 0 ? (budgetsOnTrack / budgets.length) * 100 : 0;
    
    // Eficiencia promedio (qué tan cerca del límite ideal)
    const avgEfficiency = budgetStats.length > 0 
      ? budgetStats.reduce((sum, b) => sum + Math.min(100, b.percentageUsed), 0) / budgetStats.length
      : 0;

    // Análisis comparativo
    // Mejor presupuesto: uso balanceado entre 50-75% (control ideal)
    const bestBudget = budgetStats
      .filter(b => b.percentageUsed <= 75 && b.percentageUsed >= 50)
      .sort((a, b) => b.percentageUsed - a.percentageUsed)[0] || null;
    
    // Peor presupuesto: solo los que están excedidos
    const worstBudget = budgetStats
      .filter(b => b.isExceeded)
      .sort((a, b) => b.percentageUsed - a.percentageUsed)[0] || null;

    // Generar alertas
    const alerts: Alert[] = [];
    
    // Presupuestos excedidos
    budgetStats.filter(b => b.isExceeded).forEach(budget => {
      alerts.push({
        type: 'exceeded',
        category: 'Presupuesto Excedido',
        message: `${budget.name} ha excedido su límite en ${((budget.percentageUsed - 100).toFixed(1))}%`,
        level: 'warning'
      });
    });

    // Presupuestos en riesgo crítico
    budgetStats.filter(b => b.status === 'critical' && !b.isExceeded).forEach(budget => {
      alerts.push({
        type: 'critical',
        category: 'Riesgo Crítico',
        message: `${budget.name} está al ${budget.percentageUsed.toFixed(1)}% con ${budget.remainingDays} días restantes`,
        level: 'warning'
      });
    });

    // Oportunidades de ahorro
    budgetStats.filter(b => b.percentageUsed < 50 && b.elapsedDays > b.totalDays * 0.5).forEach(budget => {
      alerts.push({
        type: 'saving_opportunity',
        category: 'Oportunidad de Ahorro',
        message: `${budget.name} tiene potencial de ahorro de ${budget.remaining.toFixed(0)} DOP`,
        level: 'info'
      });
    });

    // Análisis temporal (últimos 3 meses para tendencia)
    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
    
    const historicalBudgets = await prisma.budget.findMany({
      where: {
        user_id: userId,
        start_date: { gte: threeMonthsAgo },
        end_date: { lte: now }
      },
      include: { category: true }
    });

    // Calcular tendencia de cumplimiento
    const monthlyCompliance = new Map();
    for (const budget of historicalBudgets) {
      const monthKey = `${budget.start_date.getFullYear()}-${String(budget.start_date.getMonth() + 1).padStart(2, '0')}`;
      
      if (!monthlyCompliance.has(monthKey)) {
        monthlyCompliance.set(monthKey, { total: 0, compliant: 0 });
      }
      
      const monthData = monthlyCompliance.get(monthKey);
      monthData.total += 1;
      
      // Aquí necesitaríamos calcular si se cumplió, por simplicidad asumimos un cálculo básico
      if (parseFloat(budget.spent.toString()) <= parseFloat(budget.amount.toString())) {
        monthData.compliant += 1;
      }
    }

    const complianceTrend = Array.from(monthlyCompliance.entries()).map(([month, data]) => ({
      month,
      complianceRate: data.total > 0 ? (data.compliant / data.total) * 100 : 0,
      totalBudgets: data.total
    })).sort((a, b) => a.month.localeCompare(b.month));

    const reportData = {
      period: {
        startDate: dateStart,
        endDate: dateEnd,
        activeOnly: activeOnly === 'true'
      },
      metrics: {
        totalBudgetsActive,
        totalBudgets: budgets.length,
        totalBudgeted,
        totalSpent,
        totalRemaining,
        complianceRate,
        avgEfficiency,
        budgetsExceeded: budgetStats.filter(b => b.isExceeded).length,
        budgetsAtRisk: budgetStats.filter(b => b.status === 'critical' || b.status === 'warning').length
      },
      budgetStats: budgetStats.sort((a, b) => b.percentageUsed - a.percentageUsed),
      insights: {
        bestBudget: bestBudget ? {
          name: bestBudget.name,
          category: bestBudget.category.name,
          efficiency: bestBudget.percentageUsed
        } : null,
        worstBudget: worstBudget ? {
          name: worstBudget.name,
          category: worstBudget.category.name,
          overrun: worstBudget.percentageUsed
        } : null,
        totalSavingOpportunity: budgetStats
          .filter(b => b.percentageUsed < 80 && b.remaining > 0)
          .reduce((sum, b) => sum + b.remaining, 0),
        avgSpendVelocity: budgetStats.length > 0 
          ? budgetStats.reduce((sum, b) => sum + b.spendVelocity, 0) / budgetStats.length
          : 0
      },
      complianceTrend,
      alerts
    };

    return res.json(reportData);

  } catch (error) {
    logger.error('Error generando reporte de presupuestos:', error);
    return res.status(500).json({ message: 'Error interno del servidor' });
  }
};