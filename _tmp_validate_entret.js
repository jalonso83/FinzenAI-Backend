const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const CAT = 'cmnrn2q230000126gbzy40jld'; // Comida a domicilio

async function main() {
  const rows = await prisma.transaction.findMany({
    where: {
      category_id: CAT,
      type: 'EXPENSE',
      OR: [
        { description: { contains: 'disco', mode: 'insensitive' } },
        { description: { contains: 'vida loca', mode: 'insensitive' } },
        { description: { contains: 'salida', mode: 'insensitive' } },
        { description: { contains: 'rio', mode: 'insensitive' } },
      ],
    },
    select: { id: true, amount: true, description: true, date: true, userId: true },
    orderBy: { date: 'asc' },
  });
  console.log(`Candidatas a Entretenimiento en "Comida a domicilio": ${rows.length}\n`);
  rows.forEach(r => {
    const email = /\[Importado de Email\]/i.test(r.description || '');
    console.log(`${r.date.toISOString().slice(0,10)} | ${String(r.amount).padStart(8)} | ${email ? 'CORREO ' : 'MANUAL '} | "${r.description}" | user ${r.userId} | tx ${r.id}`);
  });
}
main().catch(e => { console.error('ERROR:', e.message); process.exit(1); }).finally(() => prisma.$disconnect());
