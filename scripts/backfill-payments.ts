/**
 * Script para generar los pagos históricos de RevenueCat que no se registraron
 *
 * Uso:
 *   set DATABASE_URL=postgresql://... && npx ts-node scripts/backfill-payments.ts
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('=== Backfill de pagos históricos de RevenueCat ===\n');

  // Buscar suscripciones ACTIVE con paymentProvider APPLE que no tienen pagos
  const activeSubs = await prisma.subscription.findMany({
    where: {
      status: 'ACTIVE',
      plan: { in: ['PREMIUM', 'PRO'] },
    },
    include: {
      user: { select: { id: true, name: true, email: true } },
    },
  });

  console.log(`Suscripciones activas pagadas encontradas: ${activeSubs.length}\n`);

  for (const sub of activeSubs) {
    console.log(`--- ${sub.user.name} (${sub.user.email}) ---`);
    console.log(`  Plan: ${sub.plan}`);
    console.log(`  Status: ${sub.status}`);
    console.log(`  Provider: ${sub.paymentProvider || 'unknown'}`);
    console.log(`  Período actual: ${sub.currentPeriodStart?.toISOString()} → ${sub.currentPeriodEnd?.toISOString()}`);
    console.log(`  Creado: ${sub.createdAt.toISOString()}`);

    // Verificar si ya tiene pagos
    const existingPayments = await prisma.payment.count({
      where: { userId: sub.userId },
    });

    if (existingPayments > 0) {
      console.log(`  ✅ Ya tiene ${existingPayments} pagos registrados. Saltando.\n`);
      continue;
    }

    // Calcular pagos históricos basados en currentPeriodEnd
    const price = sub.plan === 'PRO' ? 9.99 : 4.99;

    if (!sub.currentPeriodEnd) {
      console.log(`  ⚠️ Sin currentPeriodEnd. No se puede calcular histórico.\n`);
      continue;
    }

    // Ir hacia atrás desde currentPeriodEnd restando 1 mes por pago
    const payments: { date: Date; amount: number }[] = [];
    let periodEnd = new Date(sub.currentPeriodEnd);
    const createdAt = new Date(sub.createdAt);

    // El período actual es el más reciente — ir hacia atrás
    while (periodEnd > createdAt) {
      const periodStart = new Date(periodEnd);
      periodStart.setMonth(periodStart.getMonth() - 1);

      payments.push({
        date: periodStart, // Fecha del pago = inicio del período
        amount: price,
      });

      periodEnd = periodStart;
    }

    console.log(`  Pagos a crear: ${payments.length}`);

    for (const p of payments) {
      await prisma.payment.create({
        data: {
          userId: sub.userId,
          amount: p.amount,
          currency: 'usd',
          status: 'SUCCEEDED',
          description: `Backfill - RevenueCat ${sub.plan} monthly`,
          createdAt: p.date,
        },
      });
      console.log(`    ✅ Pago: $${p.amount} USD — ${p.date.toISOString().split('T')[0]}`);
    }
    console.log('');
  }

  console.log('=== Backfill completado ===');

  // Verificar resultado
  const totalPayments = await prisma.payment.count();
  const totalAmount = await prisma.payment.aggregate({
    _sum: { amount: true },
  });
  console.log(`Total pagos en BD: ${totalPayments}`);
  console.log(`Total ingresos: $${totalAmount._sum.amount?.toFixed(2) || 0} USD`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
