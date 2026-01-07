import { Request, Response } from 'express';

import { logger } from '../utils/logger';
// Tipos para el simulador de inversión
interface InvestmentCalculationRequest {
  monthlyAmount: number;
  years: number;
  annualInterestRate: number;
  riskLevel: 'conservative' | 'balanced' | 'aggressive';
}

interface InvestmentResult {
  totalContributed: number;
  totalInterest: number;
  finalAmount: number;
  monthlyBreakdown: MonthlyData[];
  equivalencies: string[];
  milestones: Milestone[];
  riskProfile: RiskProfile;
}

interface MonthlyData {
  month: number;
  contributed: number;
  interest: number;
  total: number;
}

interface Milestone {
  amount: number;
  month: number;
  description: string;
}

interface RiskProfile {
  level: string;
  description: string;
  minReturn: number;
  maxReturn: number;
  volatility: string;
}

// Data de equivalencias Gen Z para República Dominicana (precios actuales 2025)
const genZEquivalencies = [
  { amount: 50000, description: "Una laptop gamer de gama media 💻" },
  { amount: 75000, description: "Un iPhone 17 Pro Max nuevo 📱" },
  { amount: 120000, description: "Una moto Honda PCX nueva 🛵" },
  { amount: 200000, description: "Un semestre de universidad privada 🎓" },
  { amount: 350000, description: "Un viaje completo por Europa 15 días ✈️" },
  { amount: 500000, description: "Inicial para apartamento clase media 🏠" },
  { amount: 800000, description: "Un carro usado en buenas condiciones 🚗" },
  { amount: 1200000, description: "Un Yaris Cross nuevo 🚙" },
  { amount: 1800000, description: "Inicial para una casa en Santiago 🏡" },
  { amount: 3000000, description: "Un apartamento completo en zona popular 🏢" },
  { amount: 5000000, description: "Inicial para casa en zona residencial 🏘️" },
  { amount: 8000000, description: "Una casa completa en zona media 🏆" },
  { amount: 15000000, description: "¡Eres millonario en dólares! 💎" }
];

// Perfiles de riesgo
const riskProfiles: Record<string, RiskProfile> = {
  conservative: {
    level: "Conservador",
    description: "Como ahorrar en el banco, pero mejor",
    minReturn: 5,
    maxReturn: 7,
    volatility: "Baja"
  },
  balanced: {
    level: "Balanceado", 
    description: "Perfect balance entre riesgo y ganancia",
    minReturn: 7,
    maxReturn: 10,
    volatility: "Media"
  },
  aggressive: {
    level: "Agresivo",
    description: "Para los que quieren crecer rápido 🚀",
    minReturn: 10,
    maxReturn: 15,
    volatility: "Alta"
  }
};

// Función para calcular interés compuesto
function calculateCompoundInterest(
  monthlyAmount: number,
  years: number,
  annualRate: number
): { finalAmount: number; monthlyBreakdown: MonthlyData[] } {
  const months = years * 12;
  const monthlyRate = annualRate / 100 / 12;
  let totalContributed = 0;
  let balance = 0;
  const monthlyBreakdown: MonthlyData[] = [];

  for (let month = 1; month <= months; month++) {
    // Agregar contribución mensual
    balance += monthlyAmount;
    totalContributed += monthlyAmount;
    
    // Calcular interés sobre el balance actual
    const monthlyInterest = balance * monthlyRate;
    balance += monthlyInterest;
    
    monthlyBreakdown.push({
      month,
      contributed: totalContributed,
      interest: balance - totalContributed,
      total: balance
    });
  }

  return {
    finalAmount: balance,
    monthlyBreakdown
  };
}

// Función para generar equivalencias
function generateEquivalencies(amount: number): string[] {
  return genZEquivalencies
    .filter(eq => amount >= eq.amount)
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 4)
    .map(eq => eq.description);
}

// Función para generar hitos
function generateMilestones(monthlyBreakdown: MonthlyData[]): Milestone[] {
  const milestones: Milestone[] = [];
  const targets = [60000, 200000, 500000, 1200000, 3000000, 8000000, 15000000];
  
  targets.forEach(target => {
    const milestone = monthlyBreakdown.find(data => data.total >= target);
    if (milestone) {
      // Encontrar la equivalencia más cercana al target específico
      const equivalency = genZEquivalencies
        .filter(eq => eq.amount <= target)
        .sort((a, b) => b.amount - a.amount)[0]; // La más alta que no exceda el target
      
      milestones.push({
        amount: target,
        month: milestone.month,
        description: equivalency?.description || `RD$${target.toLocaleString()}`
      });
    }
  });
  
  return milestones.slice(0, 5); // Máximo 5 hitos
}

export const calculateInvestment = async (req: Request, res: Response) => {
  try {
    const { monthlyAmount, years, annualInterestRate, riskLevel }: InvestmentCalculationRequest = req.body;

    // Validaciones
    if (!monthlyAmount || monthlyAmount <= 0) {
      return res.status(400).json({ 
        error: 'La cantidad mensual debe ser mayor a 0' 
      });
    }

    if (!years || years <= 0 || years > 50) {
      return res.status(400).json({ 
        error: 'Los años deben estar entre 1 y 50' 
      });
    }

    if (!annualInterestRate || annualInterestRate <= 0) {
      return res.status(400).json({ 
        error: 'La tasa de interés debe ser mayor a 0' 
      });
    }

    if (!riskLevel || !riskProfiles[riskLevel]) {
      return res.status(400).json({ 
        error: 'Nivel de riesgo inválido' 
      });
    }

    // Calcular interés compuesto
    const { finalAmount, monthlyBreakdown } = calculateCompoundInterest(
      monthlyAmount,
      years,
      annualInterestRate
    );

    const totalContributed = monthlyAmount * years * 12;
    const totalInterest = finalAmount - totalContributed;

    // Generar equivalencias y hitos
    const equivalencies = generateEquivalencies(finalAmount);
    const milestones = generateMilestones(monthlyBreakdown);
    const riskProfile = riskProfiles[riskLevel];

    const result: InvestmentResult = {
      totalContributed,
      totalInterest,
      finalAmount,
      monthlyBreakdown: monthlyBreakdown.filter((_, index) => 
        index % 12 === 11 || index === monthlyBreakdown.length - 1
      ), // Solo datos anuales para reducir payload
      equivalencies,
      milestones,
      riskProfile
    };

    logger.log(`[Investment Calculator] Calculated for RD$${monthlyAmount}/month over ${years} years at ${annualInterestRate}%`);
    logger.log(`[Investment Calculator] Result: RD$${finalAmount.toLocaleString()} (contributed: RD$${totalContributed.toLocaleString()}, interest: RD$${totalInterest.toLocaleString()})`);

    return res.json(result);

  } catch (error) {
    logger.error('Error in investment calculation:', error);
    return res.status(500).json({ 
      error: 'Error interno del servidor al calcular la inversión' 
    });
  }
};

// Endpoint para obtener perfiles de riesgo disponibles
export const getRiskProfiles = async (req: Request, res: Response) => {
  try {
    return res.json(riskProfiles);
  } catch (error) {
    logger.error('Error getting risk profiles:', error);
    return res.status(500).json({ 
      error: 'Error interno del servidor' 
    });
  }
};

// Endpoint para obtener equivalencias de muestra
export const getEquivalencyExamples = async (req: Request, res: Response) => {
  try {
    const examples = genZEquivalencies.map(eq => ({
      amount: eq.amount,
      description: eq.description
    }));
    
    return res.json(examples);
  } catch (error) {
    logger.error('Error getting equivalency examples:', error);
    return res.status(500).json({ 
      error: 'Error interno del servidor' 
    });
  }
};

// ===== CALCULADORA DE METAS =====

// Tipos para la calculadora de metas
interface GoalCalculationRequest {
  goalType: 'housing' | 'vehicle' | 'business' | 'education' | 'travel' | 'custom';
  totalValue: number;
  percentage: number; // Porcentaje que se quiere ahorrar (ej: 15% para inicial)
  timeframe: number; // Meses para lograr la meta
  investmentReturn?: number; // Tasa de retorno anual opcional
}

interface GoalResult {
  goalAmount: number; // Monto final que necesita ahorrar
  totalValue: number; // Valor total de la meta
  percentage: number; // Porcentaje del total
  timeframe: number; // Meses
  monthlySavingsRequired: number; // Sin inversión
  monthlyInvestmentRequired: number; // Con inversión
  investmentAdvantage: number; // Cuánto ahorra por mes invirtiendo
  milestones: GoalMilestone[];
  goalType: string;
  description: string;
}

interface GoalMilestone {
  month: number;
  amount: number;
  percentage: number;
  description: string;
}

// Configuraciones predefinidas por tipo de meta
const goalConfigurations = {
  housing: {
    name: "Vivienda",
    icon: "🏠",
    percentageOptions: [
      { value: 10, label: "10% (mínimo FHA)", description: "Financiamiento con seguro hipotecario" },
      { value: 15, label: "15% (recomendado)", description: "Balance entre inicial y cuota mensual" },
      { value: 20, label: "20% (ideal)", description: "Sin seguro hipotecario (PMI)" },
      { value: 30, label: "30% (óptimo)", description: "Mejor tasa de interés" },
      { value: 100, label: "100% (al contado)", description: "Sin financiamiento" }
    ],
    suggestions: [
      { amount: 800000, description: "Apartamento zona popular" },
      { amount: 1500000, description: "Apartamento clase media" },
      { amount: 3000000, description: "Casa en Santiago" },
      { amount: 5000000, description: "Casa zona residencial" }
    ]
  },
  vehicle: {
    name: "Vehículo", 
    icon: "🚗",
    percentageOptions: [
      { value: 20, label: "20% inicial", description: "Financiamiento a 5 años" },
      { value: 30, label: "30% inicial", description: "Mejor tasa de interés" },
      { value: 50, label: "50% inicial", description: "Cuotas más bajas" },
      { value: 100, label: "100% al contado", description: "Sin intereses" }
    ],
    suggestions: [
      { amount: 400000, description: "Carro usado en buen estado" },
      { amount: 800000, description: "Carro nuevo económico" },
      { amount: 1200000, description: "SUV nuevo" },
      { amount: 2000000, description: "Vehículo premium" }
    ]
  },
  business: {
    name: "Negocio",
    icon: "🏢", 
    percentageOptions: [
      { value: 50, label: "50% del capital", description: "Buscar socio/inversionista" },
      { value: 75, label: "75% del capital", description: "Reserva para imprevistos" },
      { value: 100, label: "100% del capital", description: "Capital completo propio" }
    ],
    suggestions: [
      { amount: 200000, description: "Negocio pequeño (colmado, cafetería)" },
      { amount: 500000, description: "Negocio mediano (restaurante)" },
      { amount: 1000000, description: "Negocio grande (distribuidora)" },
      { amount: 2000000, description: "Franquicia reconocida" }
    ]
  }
};

// Función para calcular meta
function calculateGoalSavings(
  goalAmount: number,
  months: number, 
  annualReturn: number = 0
): { monthlySavings: number; totalContributed: number; totalInterest: number } {
  if (annualReturn === 0) {
    // Sin inversión - ahorro simple
    return {
      monthlySavings: goalAmount / months,
      totalContributed: goalAmount,
      totalInterest: 0
    };
  }

  // Con inversión - fórmula correcta de valor futuro de anualidades
  const monthlyReturn = annualReturn / 12 / 100;
  
  // PMT = FV * r / ((1 + r)^n - 1)
  // donde PMT = pago mensual, FV = valor futuro, r = tasa mensual, n = número de pagos
  const monthlySavings = goalAmount * monthlyReturn / (Math.pow(1 + monthlyReturn, months) - 1);
  const totalContributed = monthlySavings * months;
  const totalInterest = goalAmount - totalContributed;

  return {
    monthlySavings,
    totalContributed, 
    totalInterest
  };
}

// Endpoint principal para calcular metas
export const calculateGoal = async (req: Request, res: Response) => {
  try {
    const { 
      goalType, 
      totalValue, 
      percentage, 
      timeframe, 
      investmentReturn = 0 
    }: GoalCalculationRequest = req.body;

    // Validaciones
    if (!goalType || !goalConfigurations[goalType as keyof typeof goalConfigurations]) {
      return res.status(400).json({ 
        error: 'Tipo de meta inválido' 
      });
    }

    if (!totalValue || totalValue <= 0) {
      return res.status(400).json({ 
        error: 'El valor total debe ser mayor a 0' 
      });
    }

    if (!percentage || percentage <= 0 || percentage > 100) {
      return res.status(400).json({ 
        error: 'El porcentaje debe estar entre 1 y 100' 
      });
    }

    if (!timeframe || timeframe <= 0 || timeframe > 360) {
      return res.status(400).json({ 
        error: 'El plazo debe estar entre 1 y 360 meses' 
      });
    }

    // Cálculos
    const goalAmount = (totalValue * percentage) / 100;
    const config = goalConfigurations[goalType as keyof typeof goalConfigurations];

    // Calcular sin inversión
    const simpleSavings = calculateGoalSavings(goalAmount, timeframe, 0);
    
    // Calcular con inversión (si se especifica)
    const investmentSavings = investmentReturn > 0 
      ? calculateGoalSavings(goalAmount, timeframe, investmentReturn)
      : simpleSavings;

    // Generar hitos
    const milestones: GoalMilestone[] = [];
    const quarterMilestones = [25, 50, 75, 100];
    
    quarterMilestones.forEach(percent => {
      const milestoneAmount = (goalAmount * percent) / 100;
      const month = Math.round((timeframe * percent) / 100);
      
      milestones.push({
        month: month,
        amount: milestoneAmount,
        percentage: percent,
        description: percent === 100 ? "¡META ALCANZADA!" : `${percent}% completado`
      });
    });

    const result: GoalResult = {
      goalAmount,
      totalValue,
      percentage,
      timeframe,
      monthlySavingsRequired: simpleSavings.monthlySavings,
      monthlyInvestmentRequired: investmentSavings.monthlySavings,
      investmentAdvantage: simpleSavings.monthlySavings - investmentSavings.monthlySavings,
      milestones,
      goalType: config.name,
      description: `${config.icon} ${config.name} - ${percentage}% del valor total`
    };

    logger.log(`[Goal Calculator] Calculated goal: ${config.name} RD$${goalAmount.toLocaleString()} in ${timeframe} months`);
    logger.log(`[Goal Calculator] Monthly required: Simple RD$${simpleSavings.monthlySavings.toFixed(0)} | Investment RD$${investmentSavings.monthlySavings.toFixed(0)}`);

    return res.json(result);

  } catch (error) {
    logger.error('Error in goal calculation:', error);
    return res.status(500).json({ 
      error: 'Error interno del servidor al calcular la meta' 
    });
  }
};

// Endpoint para obtener configuraciones de tipos de metas
export const getGoalTypes = async (req: Request, res: Response) => {
  try {
    return res.json(goalConfigurations);
  } catch (error) {
    logger.error('Error getting goal types:', error);
    return res.status(500).json({ 
      error: 'Error interno del servidor' 
    });
  }
};

// ===== SKIP VS SAVE CHALLENGE =====

// Tipos para Skip vs Save Challenge
interface SkipVsSaveRequest {
  dailyExpense: number; // Gasto diario (ej: café RD$150)
  frequency: 'daily' | 'weekly' | 'monthly'; // Frecuencia del gasto
  timeframe: number; // Meses de comparación
  investmentReturn?: number; // Tasa de retorno anual opcional
}

interface SkipVsSaveResult {
  dailyAmount: number;
  frequency: string;
  timeframe: number;
  totalSpent: number; // Total gastado en el periodo
  totalSaved: number; // Total ahorrado (sin inversión)
  totalInvested: number; // Total con inversión
  savingsAdvantage: number; // Diferencia entre gastar y ahorrar
  investmentAdvantage: number; // Diferencia entre ahorrar y invertir
  equivalencies: string[]; // Qué podrías comprar con ese dinero
  monthlyBreakdown: Array<{
    month: number;
    spent: number;
    saved: number;
    invested: number;
  }>;
  challenge: {
    title: string;
    description: string;
    icon: string;
  };
}

// Gastos típicos dominicanos Gen Z
const skipVsSaveExpenses = [
  { 
    amount: 150, 
    name: "Café en Starbucks/Juan Valdez", 
    icon: "☕", 
    frequency: "daily" as const,
    alternatives: ["Café casero (RD$25)", "Café colado tradicional (RD$15)"]
  },
  { 
    amount: 300, 
    name: "Almuerzo delivery", 
    icon: "🍔", 
    frequency: "daily" as const,
    alternatives: ["Almuerzo casero (RD$100)", "Comedor universitario (RD$80)"]
  },
  { 
    amount: 200, 
    name: "Uber corto", 
    icon: "🚗", 
    frequency: "daily" as const,
    alternatives: ["Transporte público (RD$25)", "Caminar/bicicleta (RD$0)"]
  },
  { 
    amount: 500, 
    name: "Salida nocturna fin de semana", 
    icon: "🍻", 
    frequency: "weekly" as const,
    alternatives: ["Reunión en casa (RD$150)", "Actividad gratuita (RD$0)"]
  },
  { 
    amount: 800, 
    name: "Streaming (Netflix + Spotify + Disney)", 
    icon: "📱", 
    frequency: "monthly" as const,
    alternatives: ["Un servicio (RD$300)", "Compartir cuentas (RD$200)"]
  },
  { 
    amount: 2000, 
    name: "Compras online impulsivas", 
    icon: "🛍️", 
    frequency: "monthly" as const,
    alternatives: ["Compras planificadas", "Lista de deseos mensual"]
  }
];

// Función para calcular Skip vs Save
function calculateSkipVsAve(
  dailyAmount: number,
  frequency: 'daily' | 'weekly' | 'monthly',
  months: number,
  annualReturn: number = 0
): { totalSpent: number; totalSaved: number; totalInvested: number; monthlyBreakdown: any[] } {
  
  // Convertir a cantidad mensual
  let monthlyAmount = 0;
  switch (frequency) {
    case 'daily':
      monthlyAmount = dailyAmount * 30; // Aproximadamente 30 días por mes
      break;
    case 'weekly':
      monthlyAmount = dailyAmount * 4.33; // Aproximadamente 4.33 semanas por mes
      break;
    case 'monthly':
      monthlyAmount = dailyAmount;
      break;
  }

  const totalSpent = monthlyAmount * months;
  const totalSaved = monthlyAmount * months; // Sin inversión, solo ahorrar
  
  // Con inversión usando interés compuesto
  let totalInvested = 0;
  const monthlyBreakdown = [];
  let investmentBalance = 0;
  const monthlyReturn = annualReturn / 12 / 100;

  for (let month = 1; month <= months; month++) {
    const monthSpent = monthlyAmount * month;
    const monthSaved = monthlyAmount * month;
    
    // Calcular inversión con interés compuesto
    investmentBalance += monthlyAmount;
    if (annualReturn > 0) {
      investmentBalance *= (1 + monthlyReturn);
    }
    
    monthlyBreakdown.push({
      month,
      spent: monthSpent,
      saved: monthSaved,
      invested: Math.round(investmentBalance)
    });
  }
  
  totalInvested = investmentBalance;

  return {
    totalSpent,
    totalSaved,
    totalInvested: Math.round(totalInvested),
    monthlyBreakdown
  };
}

// Endpoint principal para Skip vs Save Challenge
export const calculateSkipVsSave = async (req: Request, res: Response) => {
  try {
    const { 
      dailyExpense, 
      frequency, 
      timeframe, 
      investmentReturn = 8 
    }: SkipVsSaveRequest = req.body;

    // Validaciones
    if (!dailyExpense || dailyExpense <= 0) {
      return res.status(400).json({ 
        error: 'El gasto diario debe ser mayor a 0' 
      });
    }

    if (!frequency || !['daily', 'weekly', 'monthly'].includes(frequency)) {
      return res.status(400).json({ 
        error: 'Frecuencia inválida. Debe ser daily, weekly o monthly' 
      });
    }

    if (!timeframe || timeframe <= 0 || timeframe > 240) {
      return res.status(400).json({ 
        error: 'El plazo debe estar entre 1 y 240 meses' 
      });
    }

    // Calcular resultados
    const calculations = calculateSkipVsAve(dailyExpense, frequency, timeframe, investmentReturn);
    
    // Generar equivalencias
    const finalAmount = investmentReturn > 0 ? calculations.totalInvested : calculations.totalSaved;
    const equivalencies = generateEquivalencies(finalAmount);
    
    // Encontrar el gasto más similar para el challenge
    const similarExpense = skipVsSaveExpenses.find(exp => 
      Math.abs(exp.amount - dailyExpense) < 100 && exp.frequency === frequency
    ) || skipVsSaveExpenses[0];

    // Traducir frecuencia
    const frequencyText = {
      daily: 'diario',
      weekly: 'semanal', 
      monthly: 'mensual'
    }[frequency];

    const result: SkipVsSaveResult = {
      dailyAmount: dailyExpense,
      frequency: frequencyText,
      timeframe,
      totalSpent: calculations.totalSpent,
      totalSaved: calculations.totalSaved,
      totalInvested: calculations.totalInvested,
      savingsAdvantage: calculations.totalSaved - calculations.totalSpent,
      investmentAdvantage: calculations.totalInvested - calculations.totalSaved,
      equivalencies,
      monthlyBreakdown: calculations.monthlyBreakdown,
      challenge: {
        title: `Reto: Evita ${similarExpense.name}`,
        description: `Si evitas gastar RD$${dailyExpense} ${frequencyText} durante ${timeframe} meses...`,
        icon: similarExpense.icon
      }
    };

    logger.log(`[Skip vs Save] Challenge: RD$${dailyExpense} ${frequency} for ${timeframe} months`);
    logger.log(`[Skip vs Save] Results: Spent RD$${calculations.totalSpent.toLocaleString()} | Saved RD$${calculations.totalSaved.toLocaleString()} | Invested RD$${calculations.totalInvested.toLocaleString()}`);

    return res.json(result);

  } catch (error) {
    logger.error('Error in skip vs save calculation:', error);
    return res.status(500).json({ 
      error: 'Error interno del servidor al calcular el reto' 
    });
  }
};

// Endpoint para obtener gastos comunes sugeridos
export const getCommonExpenses = async (req: Request, res: Response) => {
  try {
    return res.json(skipVsSaveExpenses);
  } catch (error) {
    logger.error('Error getting common expenses:', error);
    return res.status(500).json({ 
      error: 'Error interno del servidor' 
    });
  }
};

// ===== CALCULADORA DE INFLACIÓN =====

// Tipos para la calculadora de inflación
interface InflationCalculationRequest {
  currentAmount: number; // Monto actual en RD$
  years: number; // Años a futuro
  inflationRate?: number; // Tasa de inflación anual opcional
}

interface InflationResult {
  currentAmount: number;
  futureAmount: number; // Valor futuro nominal (sin ajustar)
  realValue: number; // Poder adquisitivo real
  lostValue: number; // Dinero que "pierdes" por inflación
  inflationRate: number;
  years: number;
  examples: Array<{
    item: string;
    currentPrice: number;
    futurePrice: number;
    icon: string;
  }>;
  impactMessage: string;
}

// Ejemplos de precios actuales dominicanos Gen Z (2025)
const currentPricesDR = [
  { item: "iPhone 17 Pro Max", price: 75000, icon: "📱" },
  { item: "Gasolina Regular (galón)", price: 290, icon: "⛽" },
  { item: "Combo McDonald's", price: 650, icon: "🍔" },
  { item: "Entrada cine (Palacio del Cine)", price: 450, icon: "🎬" },
  { item: "Uber 10km en Santiago", price: 350, icon: "🚗" },
  { item: "Mensualidad PUCMM", price: 85000, icon: "🎓" },
  { item: "Apartamento 1 habitación/mes", price: 25000, icon: "🏠" },
  { item: "Salario mínimo mensual", price: 21000, icon: "💼" },
  { item: "Libra de pollo", price: 150, icon: "🍗" },
  { item: "Plan Claro 20GB", price: 1200, icon: "📞" }
];

// Función para calcular inflación
function calculateInflationImpact(
  currentAmount: number,
  years: number,
  annualInflation: number
): {
  futureAmount: number;
  realValue: number;
  lostValue: number;
} {
  // Valor futuro nominal (lo que dice el dinero)
  const futureAmount = currentAmount;
  
  // Poder adquisitivo real (lo que realmente puedes comprar)
  const realValue = currentAmount / Math.pow(1 + annualInflation / 100, years);
  
  // Valor perdido por inflación
  const lostValue = currentAmount - realValue;

  return {
    futureAmount,
    realValue,
    lostValue
  };
}

// Función para generar ejemplos de precios futuros
function generateInflationExamples(
  years: number,
  inflationRate: number
): Array<{ item: string; currentPrice: number; futurePrice: number; icon: string }> {
  
  return currentPricesDR.slice(0, 6).map(item => ({
    item: item.item,
    currentPrice: item.price,
    futurePrice: Math.round(item.price * Math.pow(1 + inflationRate / 100, years)),
    icon: item.icon
  }));
}

// Endpoint principal para calcular inflación
export const calculateInflation = async (req: Request, res: Response) => {
  try {
    const { 
      currentAmount, 
      years, 
      inflationRate = 7 // Inflación promedio RD histórica
    }: InflationCalculationRequest = req.body;

    // Validaciones
    if (!currentAmount || currentAmount <= 0) {
      return res.status(400).json({ 
        error: 'El monto actual debe ser mayor a 0' 
      });
    }

    if (!years || years <= 0 || years > 50) {
      return res.status(400).json({ 
        error: 'Los años deben estar entre 1 y 50' 
      });
    }

    if (inflationRate < 0 || inflationRate > 100) {
      return res.status(400).json({ 
        error: 'La tasa de inflación debe estar entre 0 y 100%' 
      });
    }

    // Calcular impacto de inflación
    const calculations = calculateInflationImpact(currentAmount, years, inflationRate);
    
    // Generar ejemplos de precios
    const examples = generateInflationExamples(years, inflationRate);
    
    // Generar mensaje de impacto
    const percentageLost = ((calculations.lostValue / currentAmount) * 100).toFixed(1);
    const impactMessage = `En ${years} años, tus RD$${currentAmount.toLocaleString()} perderán ${percentageLost}% de su poder de compra por culpa de la inflación`;

    const result: InflationResult = {
      currentAmount,
      futureAmount: calculations.futureAmount,
      realValue: Math.round(calculations.realValue),
      lostValue: Math.round(calculations.lostValue),
      inflationRate,
      years,
      examples,
      impactMessage
    };

    logger.log(`[Inflation Calculator] RD$${currentAmount} over ${years} years at ${inflationRate}% inflation`);
    logger.log(`[Inflation Calculator] Real value: RD$${result.realValue.toLocaleString()} (lost: RD$${result.lostValue.toLocaleString()})`);

    return res.json(result);

  } catch (error) {
    logger.error('Error in inflation calculation:', error);
    return res.status(500).json({ 
      error: 'Error interno del servidor al calcular la inflación' 
    });
  }
};

// Endpoint para obtener precios actuales de referencia
export const getCurrentPrices = async (req: Request, res: Response) => {
  try {
    return res.json(currentPricesDR);
  } catch (error) {
    logger.error('Error getting current prices:', error);
    return res.status(500).json({ 
      error: 'Error interno del servidor' 
    });
  }
};

