import { prisma } from '../lib/prisma';
import { logger } from '../utils/logger';
import { getTimezoneByCountry, getTimezoneOffset } from '../utils/timezone';
import { buscarPresupuestoSolapado } from './budgetService';

export class BudgetRenewalService {
  /**
   * Función principal para renovar presupuestos vencidos
   * Se ejecuta diariamente via cron job
   */
  static async renewExpiredBudgets(): Promise<void> {
    logger.log('[BudgetRenewal] Iniciando renovación de presupuestos vencidos...');
    
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

      logger.log(`[BudgetRenewal] Encontrados ${expiredBudgets.length} presupuestos vencidos`);

      let renewedCount = 0;

      for (const budget of expiredBudgets) {
        try {
          // Cuenta solo lo REALMENTE renovado. Antes sumaba siempre, asi que el
          // log decia "50/50 renovados" aunque no se hubiera creado nada - justo
          // la metrica que hace falta para ver si el compare-and-swap actua.
          const renovado = await this.renewSingleBudget(budget);
          if (!renovado) continue;
          renewedCount++;
          logger.log(`[BudgetRenewal] ✅ Renovado: ${budget.name} del usuario ${budget.user.name}`);
        } catch (error) {
          logger.error(`[BudgetRenewal] ❌ Error renovando presupuesto ${budget.id}:`, error);
        }
      }

      logger.log(`[BudgetRenewal] ✅ Renovación completada. ${renewedCount}/${expiredBudgets.length} presupuestos renovados.`);

    } catch (error) {
      logger.error('[BudgetRenewal] ❌ Error en renovación de presupuestos:', error);
    }
  }

  /**
   * Renueva un presupuesto individual
   */
  private static async renewSingleBudget(expiredBudget: any): Promise<boolean> {
    const { user, period } = expiredBudget;
    
    // Obtener zona horaria del usuario usando su país (usando utilidad compartida)
    const userTimezone = getTimezoneByCountry(user.country);
    
    // Calcular las nuevas fechas del período
    const newDates = this.calculateNextPeriod(
      expiredBudget.end_date,
      period,
      userTimezone
    );

    // Transacción para marcar el anterior como inactivo y crear el nuevo.
    //
    // ─── Por qué esto es un compare-and-swap y no un update normal ─────────────
    //
    // Esta renovación es la causa comprobada del 90% de los presupuestos
    // duplicados que había en producción (45 de 50 pares solapados nacieron el
    // 2026-08-01 a la 01:00 UTC, en parejas separadas por 15-150 MILISEGUNDOS:
    // imposible que sea un usuario tocando "Guardar" dos veces).
    //
    // El motivo: `update` incondicional. Si el cron llega a correr dos veces a la
    // vez —dos instancias durante un deploy de Railway, o alguien pegándole al
    // endpoint /api/scheduler mientras corre el cron— las dos ejecuciones ven el
    // presupuesto todavía activo, las dos lo desactivan y las dos crean el nuevo.
    // El guard `isRunning` de BudgetScheduler es una variable de proceso: no
    // protege absolutamente nada entre procesos distintos.
    //
    // Con `updateMany` + `is_active: true` en el WHERE, quien llegue segundo
    // encuentra 0 filas (Postgres lo bloquea a nivel de fila hasta el commit del
    // primero) y se va sin crear nada. La condición vive en la base, que es el
    // único sitio donde dos procesos se ponen de acuerdo.
    return prisma.$transaction(async (tx) => {
      // 0. Mismo lock que usa `crearPresupuestoSinSolapar`, para que el cron y una
      //    creación del usuario no se pisen entre sí. Se toma ANTES del
      //    compare-and-swap para que el orden de adquisición sea siempre el
      //    mismo y no haya deadlocks.
      await tx.$executeRawUnsafe(
        'SELECT pg_advisory_xact_lock(hashtext($1)::bigint)',
        `budget:${expiredBudget.user_id}:${expiredBudget.category_id}`
      );

      // 1. Reclamar el presupuesto vencido: solo lo renueva quien consiga
      //    pasarlo de activo a inactivo.
      const reclamado = await tx.budget.updateMany({
        where: {
          id: expiredBudget.id,
          is_active: true
        },
        data: {
          is_active: false,
          updated_at: new Date()
        }
      });

      if (reclamado.count === 0) {
        logger.log(`[BudgetRenewal] ⏭️ ${expiredBudget.id} ya fue renovado por otra ejecución; se omite`);
        return false;
      }

      // 2. No renovar encima de otro presupuesto activo de la misma categoría.
      //
      //    Cubre dos casos reales:
      //    a) El usuario ya creó a mano el presupuesto del período siguiente
      //       (permitido: cuando lo creó no se solapaba con el vigente). Sin
      //       esto, el cron le encimaba otro.
      //    b) Los pares solapados que YA existen en la base: sin esta
      //       comprobación el cron los reproducía intactos mes tras mes. Ahora
      //       el primero renueva y el segundo se queda sin renovar, así que el
      //       par se deshace solo en el siguiente ciclo.
      //
      //    Se filtra por `period` A PROPÓSITO, y aquí sí (al crear NO se filtra).
      //    La validación vieja de createBudget comparaba el período, así que en
      //    la base hay usuarios con un semanal Y un mensual de la misma categoría,
      //    los dos legítimos. Sin este filtro, al vencer el semanal el cron
      //    encontraría el mensual, no lo renovaría, y como el paso 1 ya lo dejó
      //    inactivo el usuario PERDERÍA su presupuesto semanal para siempre, sin
      //    aviso. Comparando el período solo se frena lo que de verdad es un
      //    duplicado del mismo tipo.
      const solapado = await buscarPresupuestoSolapado(tx, {
        user_id: expiredBudget.user_id,
        category_id: expiredBudget.category_id,
        start_date: newDates.start,
        end_date: newDates.end,
        period: expiredBudget.period,
      });

      if (solapado) {
        logger.log(
          `[BudgetRenewal] ⏭️ ${expiredBudget.id} no se renueva: ya hay un presupuesto activo ` +
          `de esa categoría (${solapado.id}) en el período nuevo`
        );
        return false;
      }

      // 3. Crear el nuevo presupuesto con las mismas características
      await tx.budget.create({
        data: {
          user_id: expiredBudget.user_id,
          name: expiredBudget.name,
          category_id: expiredBudget.category_id,
          amount: expiredBudget.amount,
          period: expiredBudget.period,
          // `type` y `description` DEBEN copiarse. Sin `type`, Prisma aplica el
          // default EXPENSE y un presupuesto de INGRESO se convertía en uno de
          // gasto al renovarse — su `spent` pasaba a acumular gastos. Sin
          // `description`, la nota del usuario desaparecía en cada ciclo (dos
          // veces al mes en los quincenales).
          type: expiredBudget.type,
          description: expiredBudget.description,
          alert_percentage: expiredBudget.alert_percentage,
          start_date: newDates.start,
          end_date: newDates.end,
          spent: 0, // Reiniciar el gasto
          is_active: true
        }
      });

      return true;
    }, {
      // Por defecto Prisma corta a los 5s. Esta transaccion puede quedarse
      // esperando en el advisory lock detras de una creacion de usuario, que
      // pide hasta 15s; con el default saltaria P2028 sin necesidad.
      maxWait: 10000,
      timeout: 15000,
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
    
    const offset = getTimezoneOffset(timezone);
    
    // Calcular el día siguiente al vencimiento en la zona horaria del usuario
    const nextDay = new Date(lastEndDate);
    nextDay.setDate(nextDay.getDate() + 1);
    
    let endDate: Date;
    
    switch (period.toLowerCase()) {
      case 'weekly':
        endDate = new Date(nextDay);
        endDate.setDate(endDate.getDate() + 6); // 7 días total (incluyendo el día de inicio)
        break;
        
      case 'biweekly':
        // Quincenas del CALENDARIO, no "+15 días": del 1 al 15 y del 16 al
        // último día del mes. Sumar 15 días fijos desincronizaría el
        // presupuesto del mes en pocos ciclos (los meses no miden 30 días).
        endDate = new Date(nextDay);
        if (nextDay.getDate() <= 15) {
          endDate.setDate(15);
        } else {
          // Día 0 del mes siguiente = último día de este mes, y `setMonth` con
          // el día explícito evita el desbordamiento cuando el día actual no
          // existe en el mes siguiente (31 → feb).
          //
          // OJO: hay que CONSERVAR la hora de `nextDay`. Construyéndolo con
          // `new Date(y, m+1, 0)` salía a las 00:00 y el ajuste de zona horaria
          // de abajo (restar 4 h en RD) lo tiraba al día anterior, con lo que el
          // último día del mes quedaba fuera de toda ventana y sus gastos no
          // sumaban a ningún presupuesto.
          endDate = new Date(nextDay);
          endDate.setMonth(endDate.getMonth() + 1, 0);
        }
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