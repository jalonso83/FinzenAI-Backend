import { Request, Response } from 'express';

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
  { amount: 60000, description: "Un iPhone 15 Pro Max nuevo 📱" },
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

    console.log(`[Investment Calculator] Calculated for RD$${monthlyAmount}/month over ${years} years at ${annualInterestRate}%`);
    console.log(`[Investment Calculator] Result: RD$${finalAmount.toLocaleString()} (contributed: RD$${totalContributed.toLocaleString()}, interest: RD$${totalInterest.toLocaleString()})`);

    return res.json(result);

  } catch (error) {
    console.error('Error in investment calculation:', error);
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
    console.error('Error getting risk profiles:', error);
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
    console.error('Error getting equivalency examples:', error);
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

  // Con inversión - fórmula de anualidades
  const monthlyReturn = annualReturn / 12 / 100;
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

    console.log(`[Goal Calculator] Calculated goal: ${config.name} RD$${goalAmount.toLocaleString()} in ${timeframe} months`);
    console.log(`[Goal Calculator] Monthly required: Simple RD$${simpleSavings.monthlySavings.toFixed(0)} | Investment RD$${investmentSavings.monthlySavings.toFixed(0)}`);

    return res.json(result);

  } catch (error) {
    console.error('Error in goal calculation:', error);
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
    console.error('Error getting goal types:', error);
    return res.status(500).json({ 
      error: 'Error interno del servidor' 
    });
  }
};