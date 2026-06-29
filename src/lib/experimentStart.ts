import { prisma } from './prisma';

/**
 * Auto-determinación de la fecha de inicio de un experimento.
 *
 * Devuelve `startedAt` para `key`, estampándolo la PRIMERA vez que se llama (= el
 * momento real en que el experimento se volvió live, no una inferencia sobre datos
 * de usuarios). Inmutable una vez creado: las llamadas siguientes devuelven la misma
 * fecha. Reemplaza el manejo manual por env var.
 *
 * Llamar desde el gate del experimento cuando el flag está ENABLED. La carrera entre
 * requests simultáneos se resuelve con upsert (key es único).
 */
export async function getOrStampExperimentStart(key: string): Promise<Date> {
  const existing = await prisma.experiment.findUnique({
    where: { key },
    select: { startedAt: true },
  });
  if (existing) return existing.startedAt;

  const row = await prisma.experiment.upsert({
    where: { key },
    update: {},
    create: { key },
    select: { startedAt: true },
  });
  return row.startedAt;
}

/**
 * Solo lectura: la fecha de inicio si ya está estampada, o null si el experimento
 * todavía no se ha visto live. Para el panel de stats (no estampa nada).
 */
export async function getExperimentStart(key: string): Promise<Date | null> {
  const row = await prisma.experiment.findUnique({
    where: { key },
    select: { startedAt: true },
  });
  return row?.startedAt ?? null;
}
