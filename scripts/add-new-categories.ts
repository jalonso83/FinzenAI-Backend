/**
 * Script para agregar las nuevas categorías de INCOME
 *
 * Uso:
 *   set DATABASE_URL=postgresql://... && npx ts-node scripts/add-new-categories.ts
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const newIncomeCategories = [
  {
    name: 'Emprendimiento',
    type: 'INCOME' as const,
    icon: '🚀',
    isDefault: true,
  },
  {
    name: 'Remesas',
    type: 'INCOME' as const,
    icon: '🌎',
    isDefault: true,
  },
  {
    name: 'Bonificaciones',
    type: 'INCOME' as const,
    icon: '🎯',
    isDefault: true,
  },
];

async function main() {
  console.log('=== Agregando nuevas categorías de INCOME ===\n');

  for (const cat of newIncomeCategories) {
    // Verificar si ya existe
    const existing = await prisma.category.findFirst({
      where: { name: cat.name },
    });

    if (existing) {
      console.log(`⏭️  "${cat.name}" ya existe (id: ${existing.id}). Saltando.`);
      continue;
    }

    const created = await prisma.category.create({
      data: cat,
    });
    console.log(`✅ "${created.name}" ${created.icon} creada (id: ${created.id})`);
  }

  // Verificar resultado
  console.log('\n=== Categorías INCOME actuales ===');
  const incomes = await prisma.category.findMany({
    where: { type: 'INCOME' },
    orderBy: { name: 'asc' },
  });
  incomes.forEach(c => console.log(`  ${c.icon} ${c.name} (${c.id})`));
  console.log(`\nTotal INCOME: ${incomes.length}`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
