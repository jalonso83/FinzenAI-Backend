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

// Data de equivalencias Gen Z para República Dominicana
const genZEquivalencies = [
  { amount: 50000, description: "25 iPhones nuevos 📱" },
  { amount: 100000, description: "Un Yaris nuevo 🚗" },
  { amount: 200000, description: "2 años de universidad privada 🎓" },
  { amount: 300000, description: "10 viajes a Miami ✈️" },
  { amount: 500000, description: "Inicial para apartamento 🏠" },
  { amount: 800000, description: "40 conciertos de Bad Bunny 🎵" },
  { amount: 1000000, description: "¡Eres oficialmente millonario! 💎" },
  { amount: 1500000, description: "Una casa en la playa 🏖️" },
  { amount: 2000000, description: "Un Jeep Wrangler nuevo 🚙" },
  { amount: 3000000, description: "3 años viviendo como influencer 📸" },
  { amount: 5000000, description: "Tu propio negocio exitoso 🏢" }
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
  const targets = [50000, 100000, 250000, 500000, 1000000, 2000000, 5000000];
  
  targets.forEach(target => {
    const milestone = monthlyBreakdown.find(data => data.total >= target);
    if (milestone) {
      const equivalency = genZEquivalencies.find(eq => eq.amount <= target);
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

    res.json(result);

  } catch (error) {
    console.error('Error in investment calculation:', error);
    res.status(500).json({ 
      error: 'Error interno del servidor al calcular la inversión' 
    });
  }
};

// Endpoint para obtener perfiles de riesgo disponibles
export const getRiskProfiles = async (req: Request, res: Response) => {
  try {
    res.json(riskProfiles);
  } catch (error) {
    console.error('Error getting risk profiles:', error);
    res.status(500).json({ 
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
    
    res.json(examples);
  } catch (error) {
    console.error('Error getting equivalency examples:', error);
    res.status(500).json({ 
      error: 'Error interno del servidor' 
    });
  }
};