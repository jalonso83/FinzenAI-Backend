const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Backfill: copia readAt -> dismissedAt en filas existentes, para que los mensajes
// viejos ya leídos/descartados NO reaparezcan en el slot tras el deploy.
// Correr UNA sola vez, DESPUÉS de que el deploy aplique la columna dismissedAt.
async function main() {
  const before = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS n FROM notification_logs WHERE "readAt" IS NOT NULL AND "dismissedAt" IS NULL`
  );
  console.log(`Filas a backfillear (readAt set, dismissedAt null): ${before[0].n}`);

  const res = await prisma.$executeRawUnsafe(
    `UPDATE notification_logs SET "dismissedAt" = "readAt" WHERE "readAt" IS NOT NULL AND "dismissedAt" IS NULL`
  );
  console.log(`Filas actualizadas: ${res}`);

  const remaining = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS n FROM notification_logs WHERE "readAt" IS NOT NULL AND "dismissedAt" IS NULL`
  );
  console.log(`Restantes sin backfill (debe ser 0): ${remaining[0].n}`);
}
main().catch(e => { console.error('ERROR:', e.message); process.exit(1); }).finally(() => prisma.$disconnect());
