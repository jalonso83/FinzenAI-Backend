/**
 * Script para migrar categorías de EXPENSE
 *
 * 1. Reasignar transacciones de categorías a eliminar
 * 2. Reasignar presupuestos de categorías a eliminar
 * 3. Reasignar metas de categorías a eliminar
 * 4. Desactivar categorías eliminadas (isDefault: false)
 * 5. Renombrar "Servicios" → "Servicios del hogar"
 * 6. Crear 4 nuevas categorías
 *
 * Uso:
 *   set DATABASE_URL=postgresql://... && npx ts-node scripts/migrate-expense-categories.ts
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// IDs de las categorías actuales (del seed)
const CATEGORY_IDS = {
  BIENESTAR: '4662a4eb-0e9f-4eb9-9f08-04c84b348644',
  COMPRAS: 'fb561148-d4bb-4cd7-9979-2c5bed2f348a',
  TRANSFERENCIAS: '433084ac-8957-47bf-93c9-d929d963abe1',
  CUIDADO_PERSONAL: 'fee92b47-a685-40d3-95dd-b59d9d2e1d31',
  OTROS_GASTOS: '32bc498e-195c-4313-aab7-24e242028261',
  SERVICIOS: '5e3a5d25-5a81-4c26-8b72-7e7cb0580cf0',
};

// Mapeo: categoría a eliminar → categoría destino
const MIGRATION_MAP = [
  { from: CATEGORY_IDS.BIENESTAR, fromName: 'Bienestar', to: CATEGORY_IDS.CUIDADO_PERSONAL, toName: 'Cuidado personal' },
  { from: CATEGORY_IDS.COMPRAS, fromName: 'Compras', to: CATEGORY_IDS.OTROS_GASTOS, toName: 'Otros gastos' },
  { from: CATEGORY_IDS.TRANSFERENCIAS, fromName: 'Transferencias', to: CATEGORY_IDS.OTROS_GASTOS, toName: 'Otros gastos' },
];

// Nuevas categorías de EXPENSE
const NEW_EXPENSE_CATEGORIES = [
  { name: 'Delivery', type: 'EXPENSE' as const, icon: '🛵', isDefault: true },
  { name: 'Comunicaciones', type: 'EXPENSE' as const, icon: '📱', isDefault: true },
  { name: 'Seguros', type: 'EXPENSE' as const, icon: '🛡️', isDefault: true },
  { name: 'Electrónica y tecnología', type: 'EXPENSE' as const, icon: '📲', isDefault: true },
];

async function main() {
  console.log('=== Migración de categorías EXPENSE ===\n');

  // PASO 1: Diagnóstico — contar transacciones, presupuestos y metas en categorías a eliminar
  console.log('--- PASO 1: Diagnóstico ---\n');
  for (const m of MIGRATION_MAP) {
    const txCount = await prisma.transaction.count({ where: { category_id: m.from } });
    const budgetCount = await prisma.budget.count({ where: { category_id: m.from } });
    const goalCount = await prisma.goal.count({ where: { categoryId: m.from } });
    console.log(`  "${m.fromName}" → "${m.toName}":`);
    console.log(`    Transacciones: ${txCount}`);
    console.log(`    Presupuestos: ${budgetCount}`);
    console.log(`    Metas: ${goalCount}`);
    console.log('');
  }

  // PASO 2: Reasignar transacciones
  console.log('--- PASO 2: Reasignar transacciones ---\n');
  for (const m of MIGRATION_MAP) {
    const result = await prisma.transaction.updateMany({
      where: { category_id: m.from },
      data: { category_id: m.to },
    });
    console.log(`  "${m.fromName}" → "${m.toName}": ${result.count} transacciones movidas`);
  }

  // PASO 3: Reasignar presupuestos
  console.log('\n--- PASO 3: Reasignar presupuestos ---\n');
  for (const m of MIGRATION_MAP) {
    const result = await prisma.budget.updateMany({
      where: { category_id: m.from },
      data: { category_id: m.to },
    });
    console.log(`  "${m.fromName}" → "${m.toName}": ${result.count} presupuestos movidos`);
  }

  // PASO 4: Reasignar metas
  console.log('\n--- PASO 4: Reasignar metas ---\n');
  for (const m of MIGRATION_MAP) {
    const result = await prisma.goal.updateMany({
      where: { categoryId: m.from },
      data: { categoryId: m.to },
    });
    console.log(`  "${m.fromName}" → "${m.toName}": ${result.count} metas movidas`);
  }

  // PASO 5: Desactivar categorías eliminadas
  console.log('\n--- PASO 5: Desactivar categorías eliminadas ---\n');
  for (const m of MIGRATION_MAP) {
    await prisma.category.update({
      where: { id: m.from },
      data: { isDefault: false },
    });
    console.log(`  ❌ "${m.fromName}" desactivada (isDefault: false)`);
  }

  // PASO 6: Renombrar "Servicios" → "Servicios del hogar"
  console.log('\n--- PASO 6: Renombrar Servicios ---\n');
  await prisma.category.update({
    where: { id: CATEGORY_IDS.SERVICIOS },
    data: { name: 'Servicios del hogar' },
  });
  console.log('  🔄 "Servicios" → "Servicios del hogar"');

  // PASO 7: Crear nuevas categorías
  console.log('\n--- PASO 7: Crear nuevas categorías ---\n');
  for (const cat of NEW_EXPENSE_CATEGORIES) {
    const existing = await prisma.category.findFirst({ where: { name: cat.name } });
    if (existing) {
      console.log(`  ⏭️  "${cat.name}" ya existe. Saltando.`);
      continue;
    }
    const created = await prisma.category.create({ data: cat });
    console.log(`  ✅ "${created.name}" ${created.icon} creada (id: ${created.id})`);
  }

  // VERIFICACIÓN FINAL
  console.log('\n=== Verificación final ===\n');

  const activeExpense = await prisma.category.findMany({
    where: { type: 'EXPENSE', isDefault: true },
    orderBy: { name: 'asc' },
  });
  console.log(`Categorías EXPENSE activas: ${activeExpense.length}`);
  activeExpense.forEach(c => console.log(`  ${c.icon} ${c.name}`));

  const inactiveExpense = await prisma.category.findMany({
    where: { type: 'EXPENSE', isDefault: false },
    orderBy: { name: 'asc' },
  });
  console.log(`\nCategorías EXPENSE desactivadas: ${inactiveExpense.length}`);
  inactiveExpense.forEach(c => console.log(`  ❌ ${c.icon} ${c.name}`));

  // Verificar que no quedaron transacciones huérfanas
  for (const m of MIGRATION_MAP) {
    const orphaned = await prisma.transaction.count({ where: { category_id: m.from } });
    if (orphaned > 0) {
      console.log(`\n  ⚠️ ALERTA: ${orphaned} transacciones aún en "${m.fromName}"`);
    }
  }

  console.log('\n=== Migración completada ===');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
