import { PrismaClient } from '@prisma/client';
import { BudgetRenewalService } from '../services/budgetRenewalService';

const prisma = new PrismaClient();

/**
 * Script para migrar presupuestos existentes al nuevo sistema
 * Renueva automáticamente los presupuestos vencidos
 */
async function migrateBudgets() {
  console.log('🔄 Iniciando migración de presupuestos existentes...');
  
  try {
    // 1. Obtener todos los presupuestos vencidos que siguen activos
    const expiredBudgets = await prisma.budget.findMany({
      where: {
        is_active: true,
        end_date: {
          lt: new Date() // Vencidos
        }
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            country: true
          }
        },
        category: {
          select: {
            name: true
          }
        }
      }
    });

    console.log(`📊 Encontrados ${expiredBudgets.length} presupuestos vencidos para migrar`);

    if (expiredBudgets.length === 0) {
      console.log('✅ No hay presupuestos vencidos que migrar');
      return;
    }

    // 2. Mostrar resumen de lo que se va a migrar
    console.log('\n📋 Resumen de migración:');
    for (const budget of expiredBudgets) {
      console.log(`- ${budget.user.name} | ${budget.category.name} | ${budget.name} | Vencido: ${budget.end_date.toISOString().split('T')[0]}`);
    }

    // 3. Confirmar migración (en producción, quitar esto)
    console.log('\n⚠️  ¿Continuar con la migración? (y/n)');
    
    // Para ambiente de desarrollo/script, auto-continuar
    if (process.env.NODE_ENV !== 'production') {
      console.log('🧪 Ambiente de desarrollo - continuando automáticamente...');
    }

    let migratedCount = 0;
    let errorCount = 0;

    // 4. Procesar cada presupuesto vencido
    for (const budget of expiredBudgets) {
      try {
        console.log(`\n🔄 Procesando: ${budget.name} (${budget.user.name})`);
        
        // Usar el servicio existente para renovar
        await renewExpiredBudget(budget);
        
        migratedCount++;
        console.log(`  ✅ Migrado correctamente`);
        
      } catch (error) {
        errorCount++;
        console.error(`  ❌ Error migrando presupuesto ${budget.id}:`, error);
      }
    }

    console.log(`\n📊 Migración completada:`);
    console.log(`  ✅ Exitosos: ${migratedCount}`);
    console.log(`  ❌ Errores: ${errorCount}`);
    console.log(`  📊 Total: ${expiredBudgets.length}`);

  } catch (error) {
    console.error('❌ Error en migración:', error);
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Renueva un presupuesto vencido específico
 */
async function renewExpiredBudget(expiredBudget: any): Promise<void> {
  // Calcular nueva fecha basada en el período
  const today = new Date();
  let newStartDate = new Date();
  let newEndDate = new Date();

  // Calcular fechas del nuevo período basado en el período original
  switch (expiredBudget.period.toLowerCase()) {
    case 'weekly':
      newStartDate = new Date();
      newEndDate = new Date();
      newEndDate.setDate(newEndDate.getDate() + 6);
      break;
      
    case 'monthly':
      newStartDate = new Date(today.getFullYear(), today.getMonth(), 1);
      newEndDate = new Date(today.getFullYear(), today.getMonth() + 1, 0); // Último día del mes
      break;
      
    case 'yearly':
      newStartDate = new Date(today.getFullYear(), 0, 1); // 1 enero
      newEndDate = new Date(today.getFullYear(), 11, 31); // 31 diciembre
      break;
      
    default:
      // Fallback a mensual
      newStartDate = new Date(today.getFullYear(), today.getMonth(), 1);
      newEndDate = new Date(today.getFullYear(), today.getMonth() + 1, 0);
      break;
  }

  // Transacción para marcar el anterior como inactivo y crear el nuevo
  await prisma.$transaction(async (tx) => {
    // 1. Marcar el presupuesto vencido como histórico
    await tx.budget.update({
      where: { id: expiredBudget.id },
      data: { 
        is_active: false,
        updated_at: new Date()
      }
    });

    // 2. Crear el nuevo presupuesto actualizado
    await tx.budget.create({
      data: {
        user_id: expiredBudget.user_id,
        name: expiredBudget.name,
        category_id: expiredBudget.category_id,
        amount: expiredBudget.amount,
        period: expiredBudget.period,
        alert_percentage: expiredBudget.alert_percentage,
        start_date: newStartDate,
        end_date: newEndDate,
        spent: 0, // Reiniciar el gasto
        is_active: true
      }
    });
  });
}

// Ejecutar el script
if (require.main === module) {
  migrateBudgets()
    .then(() => {
      console.log('🎉 Migración completada');
      process.exit(0);
    })
    .catch((error) => {
      console.error('💥 Error fatal en migración:', error);
      process.exit(1);
    });
}

export { migrateBudgets };