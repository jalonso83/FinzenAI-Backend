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
      // Lo que llega aquí muchas veces NO es el comercio sino la `description`
      // completa de la transacción, que el email sync arma con colas:
      //   "CITIZENS INC - (****9914) - [Importado de Email] -  [USD 10.84 → DOP 636.38 @58.7]"
      //   "Amazon.com  [USD 16.95 → DOP 1003.33 @59.19]"
      // Sin cortarlas, un mismo comercio quedaba guardado en 3 variantes y el
      // match exacto casi nunca daba. Se corta en el primer " - " y se quita la
      // conversión de moneda ANTES del resto de la limpieza.
      .replace(/\s+-\s+.*$/, '')
      .replace(/\s*\[?\s*(USD|DOP|EUR|MXN|COP|PEN|CLP|ARS)\s+[\d.,]+\s*(→|->).*$/i, '')
      .replace(/\[importado de email\]/i, '')
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
   * ¿`candidate` (nombre guardado) corresponde al comercio `normalized`?
   * Igualdad exacta, o uno es prefijo del otro cortado en límite de PALABRA
   * ("SM NACIONAL SANTIAGO" ↔ "SM NACIONAL SANTIAGO 9994"). Nunca substring
   * dentro de una palabra.
   *
   * Antes esto era `contains: primeraPalabra` en la query, y esa primera
   * palabra era "SM" → hacía match con "PRICE**SM**ART". Como el resultado se
   * ordenaba por `timesUsed` y cada acierto falso le sumaba +1 al mapeo
   * equivocado, en cuanto PRICESMART se adelantó (sept-2026) TODAS las compras
   * de SM Nacional del usuario salían como Restaurantes aunque él las
   * corrigiera una por una. Bucle de retroalimentación: no se arreglaba solo.
   */
  private matchesMerchant(normalized: string, candidate: string): boolean {
    if (!candidate) return false;
    if (candidate === normalized) return true;
    const [corto, largo] = candidate.length < normalized.length ? [candidate, normalized] : [normalized, candidate];
    // Prefijo mínimo de 4 caracteres y terminado en límite de palabra
    return corto.length >= 4 && largo.startsWith(corto) && largo[corto.length] === ' ';
  }

  /**
   * Busca un mapeo para el comercio dado
   * Prioridad: Usuario > Global confiable > null
   */
  async findMapping(userId: string, merchantName: string): Promise<MappingResult | null> {
    const normalized = this.normalizeMerchantName(merchantName);
    if (!normalized) return null;

    // Se traen los candidatos y se filtra en memoria: son pocas decenas por
    // persona, y el match por prefijo de palabra no se expresa bien en Prisma.
    // `startsWith` con la primera palabra solo acota la consulta.
    const primeraPalabra = normalized.split(' ')[0];

    // 1. Mapeo del usuario (prioridad máxima). Exacto primero; si no, el
    // prefijo más largo. `updatedAt` desc desempata: la corrección más
    // reciente del usuario es la que vale.
    const candidatosUser = await prisma.merchantCategoryMapping.findMany({
      where: { userId, merchantName: { startsWith: primeraPalabra } },
      include: { category: { select: { id: true, name: true } } },
      orderBy: [{ updatedAt: 'desc' }, { timesUsed: 'desc' }]
    });
    const userMapping =
      candidatosUser.find(m => m.merchantName === normalized) ??
      candidatosUser
        .filter(m => this.matchesMerchant(normalized, m.merchantName))
        .sort((a, b) => b.merchantName.length - a.merchantName.length)[0];

    if (userMapping) {
      await this.incrementUsage(userMapping.id);
      return {
        categoryId: userMapping.categoryId,
        categoryName: userMapping.category.name,
        source: 'user',
        confidence: 100
      };
    }

    // 2. Mapeo global confiable — mismo criterio de match, sin substring
    const candidatosGlobal = await prisma.merchantCategoryMapping.findMany({
      where: {
        userId: null,
        confirmedByUsers: { gte: MIN_USERS_FOR_GLOBAL_TRUST },
        confidence: { gte: MIN_CONFIDENCE_FOR_GLOBAL },
        merchantName: { startsWith: primeraPalabra }
      },
      include: { category: { select: { id: true, name: true } } },
      orderBy: [{ confirmedByUsers: 'desc' }, { confidence: 'desc' }, { timesUsed: 'desc' }]
    });
    const globalMapping =
      candidatosGlobal.find(m => m.merchantName === normalized) ??
      candidatosGlobal.find(m => this.matchesMerchant(normalized, m.merchantName));

    if (globalMapping) {
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
