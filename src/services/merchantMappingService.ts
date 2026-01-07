/**
 * MerchantMappingService
 *
 * Servicio de aprendizaje automático para categorización de comercios.
 * Implementa un sistema híbrido:
 * 1. Primero busca mapeos del usuario específico
 * 2. Luego busca mapeos globales con alta confianza
 * 3. Si no encuentra, retorna null (usar IA)
 */

import { MappingSource } from '@prisma/client';
import { prisma } from '../lib/prisma';

import { logger } from '../utils/logger';
// Umbral mínimo de usuarios para considerar un mapeo global confiable
const MIN_USERS_FOR_GLOBAL_TRUST = 3;
const MIN_CONFIDENCE_FOR_GLOBAL = 70;

interface MappingResult {
  categoryId: string;
  categoryName: string;
  source: 'user' | 'global' | 'ai';
  confidence: number;
}

interface SaveMappingParams {
  userId: string;
  merchantName: string;
  categoryId: string;
  source: MappingSource;
}

class MerchantMappingService {

  /**
   * Normaliza el nombre del comercio para búsqueda consistente
   * - Convierte a mayúsculas
   * - Elimina espacios extra
   * - Elimina caracteres especiales comunes en emails bancarios
   */
  normalizeMerchantName(merchantName: string): string {
    if (!merchantName) return '';

    return merchantName
      .toUpperCase()
      .trim()
      // Eliminar múltiples espacios
      .replace(/\s+/g, ' ')
      // Eliminar caracteres especiales comunes
      .replace(/[*#@!$%^&()_+=\[\]{}|\\:";'<>,.?\/~`]/g, '')
      // Eliminar códigos numéricos al final (ej: "FARMACIA CAROL 12345")
      .replace(/\s+\d{4,}$/, '')
      // Eliminar prefijos comunes de tarjetas
      .replace(/^(COMPRA|PAGO|CONSUMO|CARGO)\s+/i, '')
      .trim();
  }

  /**
   * Genera un patrón para matching de variantes
   * Ej: "FARMACIA CAROL" -> "FARMACIA CAROL*"
   */
  generatePattern(merchantName: string): string {
    const normalized = this.normalizeMerchantName(merchantName);
    // Tomar las primeras 2-3 palabras significativas
    const words = normalized.split(' ').filter(w => w.length > 2);
    if (words.length >= 2) {
      return `${words.slice(0, 2).join(' ')}*`;
    }
    return `${normalized}*`;
  }

  /**
   * Busca un mapeo para el comercio dado
   * Prioridad: Usuario > Global confiable > null
   */
  async findMapping(userId: string, merchantName: string): Promise<MappingResult | null> {
    const normalized = this.normalizeMerchantName(merchantName);

    if (!normalized) return null;

    // 1. Buscar mapeo del usuario específico (prioridad máxima)
    const userMapping = await prisma.merchantCategoryMapping.findFirst({
      where: {
        userId,
        OR: [
          { merchantName: normalized },
          { merchantName: { contains: normalized.split(' ')[0] } }
        ]
      },
      include: {
        category: { select: { id: true, name: true } }
      },
      orderBy: { timesUsed: 'desc' }
    });

    if (userMapping) {
      // Incrementar contador de uso
      await this.incrementUsage(userMapping.id);

      return {
        categoryId: userMapping.categoryId,
        categoryName: userMapping.category.name,
        source: 'user',
        confidence: 100
      };
    }

    // 2. Buscar mapeo global confiable
    const globalMapping = await prisma.merchantCategoryMapping.findFirst({
      where: {
        userId: null,
        confirmedByUsers: { gte: MIN_USERS_FOR_GLOBAL_TRUST },
        confidence: { gte: MIN_CONFIDENCE_FOR_GLOBAL },
        OR: [
          { merchantName: normalized },
          { merchantName: { contains: normalized.split(' ')[0] } }
        ]
      },
      include: {
        category: { select: { id: true, name: true } }
      },
      orderBy: [
        { confirmedByUsers: 'desc' },
        { confidence: 'desc' },
        { timesUsed: 'desc' }
      ]
    });

    if (globalMapping) {
      // Incrementar contador de uso
      await this.incrementUsage(globalMapping.id);

      return {
        categoryId: globalMapping.categoryId,
        categoryName: globalMapping.category.name,
        source: 'global',
        confidence: globalMapping.confidence
      };
    }

    // 3. No se encontró mapeo - usar IA
    return null;
  }

  /**
   * Guarda o actualiza un mapeo de comercio -> categoría
   * Llamar cuando el usuario corrige una categoría
   */
  async saveMapping(params: SaveMappingParams): Promise<void> {
    const { userId, merchantName, categoryId, source } = params;
    const normalized = this.normalizeMerchantName(merchantName);

    if (!normalized) return;

    const pattern = this.generatePattern(merchantName);

    try {
      // Upsert para mapeo del usuario
      await prisma.merchantCategoryMapping.upsert({
        where: {
          userId_merchantName: {
            userId,
            merchantName: normalized
          }
        },
        update: {
          categoryId,
          source,
          timesUsed: { increment: 1 },
          updatedAt: new Date()
        },
        create: {
          userId,
          merchantName: normalized,
          merchantPattern: pattern,
          categoryId,
          source,
          timesUsed: 1,
          confirmedByUsers: 1,
          confidence: 100
        }
      });

      // También actualizar/crear mapeo global
      await this.updateGlobalMapping(normalized, categoryId, source);

    } catch (error) {
      logger.error('[MerchantMappingService] Error saving mapping:', error);
    }
  }

  /**
   * Actualiza el mapeo global basado en correcciones de usuarios
   */
  private async updateGlobalMapping(
    merchantName: string,
    categoryId: string,
    source: MappingSource
  ): Promise<void> {
    const pattern = this.generatePattern(merchantName);

    // Buscar mapeo global existente
    const existingGlobal = await prisma.merchantCategoryMapping.findFirst({
      where: {
        userId: null,
        merchantName
      }
    });

    if (existingGlobal) {
      // Si la categoría es la misma, incrementar confianza
      if (existingGlobal.categoryId === categoryId) {
        await prisma.merchantCategoryMapping.update({
          where: { id: existingGlobal.id },
          data: {
            timesUsed: { increment: 1 },
            confirmedByUsers: { increment: 1 },
            confidence: Math.min(100, existingGlobal.confidence + 5),
            updatedAt: new Date()
          }
        });
      } else {
        // Si la categoría es diferente, reducir confianza
        const newConfidence = existingGlobal.confidence - 10;

        if (newConfidence <= 30) {
          // Si la confianza es muy baja, cambiar la categoría
          await prisma.merchantCategoryMapping.update({
            where: { id: existingGlobal.id },
            data: {
              categoryId,
              confidence: 50, // Reiniciar con confianza media
              updatedAt: new Date()
            }
          });
        } else {
          await prisma.merchantCategoryMapping.update({
            where: { id: existingGlobal.id },
            data: {
              confidence: newConfidence,
              updatedAt: new Date()
            }
          });
        }
      }
    } else {
      // Crear nuevo mapeo global
      await prisma.merchantCategoryMapping.create({
        data: {
          userId: null,
          merchantName,
          merchantPattern: pattern,
          categoryId,
          source,
          timesUsed: 1,
          confirmedByUsers: 1,
          confidence: 50 // Empezar con confianza media
        }
      });
    }
  }

  /**
   * Incrementa el contador de uso de un mapeo
   */
  private async incrementUsage(mappingId: string): Promise<void> {
    try {
      await prisma.merchantCategoryMapping.update({
        where: { id: mappingId },
        data: {
          timesUsed: { increment: 1 },
          updatedAt: new Date()
        }
      });
    } catch (error) {
      // Silenciar errores de incremento
    }
  }

  /**
   * Obtiene estadísticas de mapeos para un usuario
   */
  async getUserMappingStats(userId: string): Promise<{
    userMappings: number;
    globalMappings: number;
    topCategories: { categoryName: string; count: number }[];
  }> {
    const [userCount, globalCount, topCategories] = await Promise.all([
      prisma.merchantCategoryMapping.count({
        where: { userId }
      }),
      prisma.merchantCategoryMapping.count({
        where: {
          userId: null,
          confirmedByUsers: { gte: MIN_USERS_FOR_GLOBAL_TRUST }
        }
      }),
      prisma.merchantCategoryMapping.groupBy({
        by: ['categoryId'],
        where: { userId },
        _count: { categoryId: true },
        orderBy: { _count: { categoryId: 'desc' } },
        take: 5
      })
    ]);

    // Obtener nombres de categorías
    const categoryIds = topCategories.map(tc => tc.categoryId);
    const categories = await prisma.category.findMany({
      where: { id: { in: categoryIds } },
      select: { id: true, name: true }
    });

    const categoryMap = new Map(categories.map(c => [c.id, c.name]));

    return {
      userMappings: userCount,
      globalMappings: globalCount,
      topCategories: topCategories.map(tc => ({
        categoryName: categoryMap.get(tc.categoryId) || 'Desconocida',
        count: tc._count.categoryId
      }))
    };
  }

  /**
   * Elimina un mapeo específico del usuario
   */
  async deleteUserMapping(userId: string, merchantName: string): Promise<boolean> {
    const normalized = this.normalizeMerchantName(merchantName);

    try {
      await prisma.merchantCategoryMapping.delete({
        where: {
          userId_merchantName: {
            userId,
            merchantName: normalized
          }
        }
      });
      return true;
    } catch (error) {
      return false;
    }
  }
}

export const merchantMappingService = new MerchantMappingService();
export default merchantMappingService;
