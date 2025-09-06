import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Mapeo de países a zonas horarias (usando la misma lógica que el proyecto móvil)
const COUNTRY_TO_TIMEZONE: Record<string, string> = {
  // Países latinoamericanos
  'República Dominicana': 'America/Santo_Domingo',
  'México': 'America/Mexico_City',
  'Colombia': 'America/Bogota',
  'Panamá': 'America/Panama',
  'Guatemala': 'America/Guatemala',
  'Honduras': 'America/Tegucigalpa',
  'Nicaragua': 'America/Managua',
  'Costa Rica': 'America/Costa_Rica',
  'El Salvador': 'America/El_Salvador',
  'Cuba': 'America/Havana',
  'Puerto Rico': 'America/Puerto_Rico',
  'Estados Unidos': 'America/New_York',
  'España': 'Europe/Madrid',
  'Argentina': 'America/Argentina/Buenos_Aires',
  'Chile': 'America/Santiago',
  'Uruguay': 'America/Montevideo',
  'Paraguay': 'America/Asuncion',
  'Bolivia': 'America/La_Paz',
  'Perú': 'America/Lima',
  'Ecuador': 'America/Guayaquil',
  'Venezuela': 'America/Caracas',
  'Brasil': 'America/Sao_Paulo'
};

// Reutilizar la función existente del controlador zenio
function obtenerOffsetDeTimezone(timezone: string): number {
  const timezoneOffsets: { [key: string]: number } = {
    'America/Santo_Domingo': -4,
    'America/Caracas': -4,
    'America/New_York': -5,
    'America/Chicago': -6,
    'America/Denver': -7,
    'America/Los_Angeles': -8,
    'America/Anchorage': -9,
    'Pacific/Honolulu': -10,
    'Europe/London': 0,
    'Europe/Paris': 1,
    'Europe/Berlin': 1,
    'Europe/Madrid': 1,
    'Europe/Rome': 1,
    'Europe/Moscow': 3,
    'Asia/Dubai': 4,
    'Asia/Tokyo': 9,
    'Asia/Shanghai': 8,
    'Asia/Seoul': 9,
    'Australia/Sydney': 10,
    'Pacific/Auckland': 12,
    'America/Mexico_City': -6,
    'America/Bogota': -5,
    'America/Panama': -5,
    'America/Guatemala': -6,
    'America/Tegucigalpa': -6,
    'America/Managua': -6,
    'America/Costa_Rica': -6,
    'America/El_Salvador': -6,
    'America/Havana': -5,
    'America/Puerto_Rico': -4,
    'America/Argentina/Buenos_Aires': -3,
    'America/Santiago': -4,
    'America/Montevideo': -3,
    'America/Asuncion': -3,
    'America/La_Paz': -4,
    'America/Lima': -5,
    'America/Guayaquil': -5,
    'America/Sao_Paulo': -3,
    'UTC': 0
  };
  
  return timezoneOffsets[timezone] || 0;
}

export class BudgetRenewalService {
  /**
   * Función principal para renovar presupuestos vencidos
   * Se ejecuta diariamente via cron job
   */
  static async renewExpiredBudgets(): Promise<void> {
    console.log('[BudgetRenewal] Iniciando renovación de presupuestos vencidos...');
    
    try {
      // Buscar presupuestos vencidos que sean activos
      const expiredBudgets = await prisma.budget.findMany({
        where: {
          is_active: true,
          end_date: {
            lt: new Date() // end_date menor que hoy
          }
        },
        include: {
          user: {
            select: {
              id: true,
              country: true,
              name: true
            }
          },
          category: {
            select: {
              id: true,
              name: true
            }
          }
        }
      });

      console.log(`[BudgetRenewal] Encontrados ${expiredBudgets.length} presupuestos vencidos`);

      let renewedCount = 0;

      for (const budget of expiredBudgets) {
        try {
          await this.renewSingleBudget(budget);
          renewedCount++;
          console.log(`[BudgetRenewal] ✅ Renovado: ${budget.name} del usuario ${budget.user.name}`);
        } catch (error) {
          console.error(`[BudgetRenewal] ❌ Error renovando presupuesto ${budget.id}:`, error);
        }
      }

      console.log(`[BudgetRenewal] ✅ Renovación completada. ${renewedCount}/${expiredBudgets.length} presupuestos renovados.`);

    } catch (error) {
      console.error('[BudgetRenewal] ❌ Error en renovación de presupuestos:', error);
    }
  }

  /**
   * Renueva un presupuesto individual
   */
  private static async renewSingleBudget(expiredBudget: any): Promise<void> {
    const { user, period } = expiredBudget;
    
    // Obtener zona horaria del usuario usando su país
    const userTimezone = COUNTRY_TO_TIMEZONE[user.country] || 'UTC';
    
    // Calcular las nuevas fechas del período
    const newDates = this.calculateNextPeriod(
      expiredBudget.end_date,
      period,
      userTimezone
    );

    // Transacción para marcar el anterior como inactivo y crear el nuevo
    await prisma.$transaction(async (tx) => {
      // 1. Marcar el presupuesto vencido como inactivo
      await tx.budget.update({
        where: { id: expiredBudget.id },
        data: { 
          is_active: false,
          updated_at: new Date()
        }
      });

      // 2. Crear el nuevo presupuesto con las mismas características
      await tx.budget.create({
        data: {
          user_id: expiredBudget.user_id,
          name: expiredBudget.name,
          category_id: expiredBudget.category_id,
          amount: expiredBudget.amount,
          period: expiredBudget.period,
          alert_percentage: expiredBudget.alert_percentage,
          start_date: newDates.start,
          end_date: newDates.end,
          spent: 0, // Reiniciar el gasto
          is_active: true
        }
      });
    });
  }

  /**
   * Calcula las fechas del próximo período basado en el período y zona horaria
   */
  private static calculateNextPeriod(
    lastEndDate: Date, 
    period: string, 
    timezone: string
  ): { start: Date; end: Date } {
    
    const offset = obtenerOffsetDeTimezone(timezone);
    
    // Calcular el día siguiente al vencimiento en la zona horaria del usuario
    const nextDay = new Date(lastEndDate);
    nextDay.setDate(nextDay.getDate() + 1);
    
    let endDate: Date;
    
    switch (period.toLowerCase()) {
      case 'weekly':
        endDate = new Date(nextDay);
        endDate.setDate(endDate.getDate() + 6); // 7 días total (incluyendo el día de inicio)
        break;
        
      case 'monthly':
        endDate = new Date(nextDay);
        endDate.setMonth(endDate.getMonth() + 1);
        endDate.setDate(endDate.getDate() - 1); // Último día del mes
        break;
        
      case 'yearly':
        endDate = new Date(nextDay);
        endDate.setFullYear(endDate.getFullYear() + 1);
        endDate.setDate(endDate.getDate() - 1); // Último día del año
        break;
        
      default:
        // Fallback a mensual
        endDate = new Date(nextDay);
        endDate.setMonth(endDate.getMonth() + 1);
        endDate.setDate(endDate.getDate() - 1);
        break;
    }

    // Ajustar para la zona horaria del usuario (usando la misma lógica que zenio)
    // Para zonas horarias negativas (UTC-4), sumamos las horas
    // Para zonas horarias positivas (UTC+1), restamos las horas  
    const adjustedStart = new Date(nextDay.getTime() + (offset * 60 * 60 * 1000));
    const adjustedEnd = new Date(endDate.getTime() + (offset * 60 * 60 * 1000));

    // Ajustar al final del día para end_date
    adjustedEnd.setHours(23, 59, 59, 999);

    return {
      start: adjustedStart,
      end: adjustedEnd
    };
  }

  /**
   * Función para obtener todos los presupuestos históricos de un usuario
   * para una categoría específica
   */
  static async getBudgetHistory(userId: string, categoryId?: string): Promise<any[]> {
    const where: any = { user_id: userId };
    
    if (categoryId) {
      where.category_id = categoryId;
    }

    return await prisma.budget.findMany({
      where,
      orderBy: { start_date: 'desc' },
      include: {
        category: {
          select: {
            id: true,
            name: true,
            icon: true
          }
        }
      }
    });
  }
}