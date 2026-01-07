/**
 * Prisma Client Singleton
 *
 * Este archivo implementa el patron singleton para PrismaClient.
 * Evita crear multiples conexiones a la base de datos.
 *
 * USO:
 * import { prisma } from '../lib/prisma';
 *
 * NO USAR:
 * const prisma = new PrismaClient(); // INCORRECTO
 *
 * @see https://www.prisma.io/docs/guides/performance-and-optimization/connection-management
 */

import { PrismaClient } from '@prisma/client';

import { logger } from '../utils/logger';
// Declarar tipo global para almacenar la instancia en desarrollo
declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

// Configuracion de logging segun el entorno
const logLevel = process.env.NODE_ENV === 'development'
  ? ['error', 'warn']
  : ['error'];

const prismaClientOptions = {
  log: logLevel as ('error' | 'warn')[],
};

/**
 * Instancia singleton de PrismaClient
 *
 * En desarrollo: Reutiliza la instancia global para evitar
 * "Too many connections" durante hot-reload.
 *
 * En produccion: Crea una nueva instancia (solo una por proceso).
 */
export const prisma: PrismaClient =
  global.__prisma ||
  new PrismaClient(prismaClientOptions);

// En desarrollo, guardar en global para reutilizar entre hot-reloads
if (process.env.NODE_ENV !== 'production') {
  global.__prisma = prisma;
}

/**
 * Funcion para desconectar Prisma de forma segura
 * Usar en shutdown del servidor
 */
export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
  logger.log('[Prisma] Disconnected from database');
}

/**
 * Funcion para verificar la conexion a la base de datos
 * Util para health checks
 */
export async function checkDatabaseConnection(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch (error) {
    logger.error('[Prisma] Database connection failed:', error);
    return false;
  }
}

export default prisma;
