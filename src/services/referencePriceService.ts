import { prisma } from '../lib/prisma';
import { openai } from '../openaiClient';
import { logger } from '../utils/logger';

// Configuración por defecto
const DEFAULT_CACHE_DAYS = 90; // 3 meses
const COUNTRY_CODE = 'DO'; // República Dominicana

// Estructura de categorías y sus claves
interface PriceCategory {
  name: string;
  icon: string;
  percentageOptions: Array<{
    value: number;
    label: string;
    description: string;
  }>;
  keys: string[]; // Claves para buscar precios
}

const categoryConfig: Record<string, PriceCategory> = {
  housing: {
    name: "Vivienda",
    icon: "🏠",
    percentageOptions: [
      { value: 10, label: "10% (mínimo FHA)", description: "Financiamiento con seguro hipotecario" },
      { value: 15, label: "15% (recomendado)", description: "Balance entre inicial y cuota mensual" },
      { value: 20, label: "20% (ideal)", description: "Sin seguro hipotecario (PMI)" },
      { value: 30, label: "30% (óptimo)", description: "Mejor tasa de interés" },
      { value: 100, label: "100% (al contado)", description: "Sin financiamiento" }
    ],
    keys: ['apartment_economic', 'apartment_middle', 'house_santiago', 'apartment_premium']
  },
  vehicle: {
    name: "Vehículo",
    icon: "🚗",
    percentageOptions: [
      { value: 20, label: "20% inicial", description: "Financiamiento a 5 años" },
      { value: 30, label: "30% inicial", description: "Mejor tasa de interés" },
      { value: 50, label: "50% inicial", description: "Cuotas más bajas" },
      { value: 100, label: "100% al contado", description: "Sin intereses" }
    ],
    keys: ['car_used', 'car_new_economic', 'suv_new', 'car_premium']
  },
  business: {
    name: "Negocio",
    icon: "🏢",
    percentageOptions: [
      { value: 50, label: "50% del capital", description: "Buscar socio/inversionista" },
      { value: 75, label: "75% del capital", description: "Reserva para imprevistos" },
      { value: 100, label: "100% del capital", description: "Capital completo propio" }
    ],
    keys: ['business_small', 'business_medium', 'business_large', 'franchise']
  }
};

// Descripciones por defecto para cada clave
const defaultDescriptions: Record<string, string> = {
  // Vivienda
  apartment_economic: "Apartamento económico (Sto. Dgo. Norte)",
  apartment_middle: "Apartamento clase media (Sto. Dgo. Este)",
  house_santiago: "Casa en Santiago",
  apartment_premium: "Apartamento Distrito Nacional",
  // Vehículos
  car_used: "Carro usado en buen estado",
  car_new_economic: "Carro nuevo económico",
  suv_new: "SUV nuevo",
  car_premium: "Vehículo premium",
  // Negocios
  business_small: "Negocio pequeño (colmado, cafetería)",
  business_medium: "Negocio mediano (restaurante)",
  business_large: "Negocio grande (distribuidora)",
  franchise: "Franquicia reconocida"
};

// Valores por defecto (fallback si AI falla)
const fallbackPrices: Record<string, number> = {
  // Vivienda (RD$)
  apartment_economic: 3500000,
  apartment_middle: 5500000,
  house_santiago: 7000000,
  apartment_premium: 10000000,
  // Vehículos (RD$)
  car_used: 480000,
  car_new_economic: 960000,
  suv_new: 1440000,
  car_premium: 2400000,
  // Negocios (RD$)
  business_small: 240000,
  business_medium: 600000,
  business_large: 1200000,
  franchise: 2400000
};

/**
 * Verifica si el cache necesita actualizarse
 */
async function isCacheStale(): Promise<boolean> {
  try {
    const config = await prisma.referencePriceConfig.findUnique({
      where: { country: COUNTRY_CODE }
    });

    if (!config || !config.lastFullUpdate) {
      return true;
    }

    const cacheDays = config.cacheDays || DEFAULT_CACHE_DAYS;
    const now = new Date();
    const lastUpdate = new Date(config.lastFullUpdate);
    const diffDays = (now.getTime() - lastUpdate.getTime()) / (1000 * 60 * 60 * 24);

    return diffDays >= cacheDays;
  } catch (error) {
    logger.error('[ReferencePriceService] Error checking cache:', error);
    return true;
  }
}

/**
 * Usa AI para buscar precios actualizados
 */
async function fetchPricesWithAI(): Promise<Record<string, { amount: number; description: string; source: string }>> {
  const prompt = `Eres un experto en el mercado de República Dominicana. Necesito precios actualizados en PESOS DOMINICANOS (RD$) para las siguientes categorías. Responde SOLO con un JSON válido, sin explicaciones adicionales.

CATEGORÍAS A BUSCAR:

1. VIVIENDA (precios promedio 2024-2025):
   - apartment_economic: Apartamento económico en Santo Domingo Norte o zonas populares
   - apartment_middle: Apartamento clase media en Santo Domingo Este
   - house_santiago: Casa promedio en Santiago de los Caballeros
   - apartment_premium: Apartamento en Distrito Nacional (Piantini, Naco, Evaristo Morales)

2. VEHÍCULOS (precios promedio 2024-2025):
   - car_used: Carro usado en buen estado (5-8 años, ej: Toyota Corolla, Honda Civic)
   - car_new_economic: Carro nuevo económico (ej: Suzuki Swift, Kia Picanto)
   - suv_new: SUV nuevo (ej: Toyota RAV4, Hyundai Tucson)
   - car_premium: Vehículo premium (ej: BMW Serie 3, Mercedes Clase C)

3. NEGOCIOS (inversión inicial típica):
   - business_small: Negocio pequeño (colmado, cafetería pequeña)
   - business_medium: Negocio mediano (restaurante, barbería equipada)
   - business_large: Negocio grande (distribuidora, tienda de electrodomésticos)
   - franchise: Franquicia reconocida (Domino's, Subway, etc.)

Responde con este formato JSON exacto:
{
  "apartment_economic": { "amount": 0, "description": "descripción corta", "source": "fuente de referencia" },
  "apartment_middle": { "amount": 0, "description": "descripción corta", "source": "fuente" },
  ... (todas las claves)
}

IMPORTANTE:
- Los montos deben ser en PESOS DOMINICANOS (RD$)
- Usa precios realistas del mercado actual
- La descripción debe ser corta (máximo 50 caracteres)
- La fuente puede ser "Mercado RD 2025" o similar`;

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-5.4-mini',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }]
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error('Respuesta vacía de AI');
    }

    // Extraer JSON de la respuesta
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No se encontró JSON en la respuesta');
    }

    const prices = JSON.parse(jsonMatch[0]);
    logger.log('[ReferencePriceService] AI prices fetched successfully');
    return prices;

  } catch (error) {
    logger.error('[ReferencePriceService] Error fetching AI prices:', error);
    throw error;
  }
}

/**
 * Actualiza los precios en la base de datos
 */
async function updatePricesInDB(prices: Record<string, { amount: number; description: string; source: string }>): Promise<void> {
  try {
    // Marcar que está actualizando
    await prisma.referencePriceConfig.upsert({
      where: { country: COUNTRY_CODE },
      update: { isUpdating: true },
      create: { country: COUNTRY_CODE, isUpdating: true, cacheDays: DEFAULT_CACHE_DAYS }
    });

    // Actualizar cada precio
    for (const [key, data] of Object.entries(prices)) {
      // Determinar la categoría basándose en la clave
      let category = 'custom';
      for (const [cat, config] of Object.entries(categoryConfig)) {
        if (config.keys.includes(key)) {
          category = cat;
          break;
        }
      }

      await prisma.referencePrice.upsert({
        where: {
          category_key_country: {
            category,
            key,
            country: COUNTRY_CODE
          }
        },
        update: {
          amount: data.amount,
          description: data.description,
          source: data.source
        },
        create: {
          category,
          key,
          country: COUNTRY_CODE,
          amount: data.amount,
          description: data.description,
          source: data.source
        }
      });
    }

    // Marcar actualización completa
    await prisma.referencePriceConfig.update({
      where: { country: COUNTRY_CODE },
      data: {
        isUpdating: false,
        lastFullUpdate: new Date()
      }
    });

    logger.log('[ReferencePriceService] Prices updated in DB successfully');

  } catch (error) {
    logger.error('[ReferencePriceService] Error updating prices in DB:', error);

    // Resetear flag de actualización
    await prisma.referencePriceConfig.update({
      where: { country: COUNTRY_CODE },
      data: { isUpdating: false }
    }).catch(() => {});

    throw error;
  }
}

/**
 * Obtiene precios del cache o los actualiza si están viejos
 */
async function getPricesFromCache(): Promise<Record<string, { amount: number; description: string }>> {
  try {
    const prices = await prisma.referencePrice.findMany({
      where: { country: COUNTRY_CODE }
    });

    const result: Record<string, { amount: number; description: string }> = {};
    for (const price of prices) {
      result[price.key] = {
        amount: price.amount,
        description: price.description
      };
    }

    return result;
  } catch (error) {
    logger.error('[ReferencePriceService] Error getting prices from cache:', error);
    return {};
  }
}

/**
 * Función principal: obtiene precios actualizados
 */
export async function getReferencePrices(): Promise<Record<string, {
  name: string;
  icon: string;
  percentageOptions: Array<{ value: number; label: string; description: string }>;
  suggestions: Array<{ amount: number; description: string }>;
}>> {
  try {
    const stale = await isCacheStale();

    // Si el cache está viejo, actualizar en background
    if (stale) {
      logger.log('[ReferencePriceService] Cache is stale, updating in background...');

      // Verificar si ya está actualizando
      const config = await prisma.referencePriceConfig.findUnique({
        where: { country: COUNTRY_CODE }
      });

      if (!config?.isUpdating) {
        // Actualizar en background (no bloquear la respuesta)
        updatePricesAsync().catch(err => {
          logger.error('[ReferencePriceService] Background update failed:', err);
        });
      }
    }

    // Obtener precios del cache
    const cachedPrices = await getPricesFromCache();

    // Construir respuesta con la estructura esperada
    const result: Record<string, any> = {};

    for (const [category, config] of Object.entries(categoryConfig)) {
      const suggestions: Array<{ amount: number; description: string }> = [];

      for (const key of config.keys) {
        const cached = cachedPrices[key];
        suggestions.push({
          amount: cached?.amount || fallbackPrices[key] || 0,
          description: cached?.description || defaultDescriptions[key] || key
        });
      }

      result[category] = {
        name: config.name,
        icon: config.icon,
        percentageOptions: config.percentageOptions,
        suggestions
      };
    }

    return result;

  } catch (error) {
    logger.error('[ReferencePriceService] Error getting reference prices:', error);

    // Fallback: retornar precios por defecto
    return buildFallbackResponse();
  }
}

/**
 * Actualiza precios de forma asíncrona
 */
async function updatePricesAsync(): Promise<void> {
  try {
    const prices = await fetchPricesWithAI();
    await updatePricesInDB(prices);
  } catch (error) {
    logger.error('[ReferencePriceService] Async update failed:', error);
  }
}

/**
 * Fuerza una actualización de precios (para uso administrativo)
 */
export async function forceUpdatePrices(): Promise<{ success: boolean; message: string }> {
  try {
    logger.log('[ReferencePriceService] Force update requested');
    const prices = await fetchPricesWithAI();
    await updatePricesInDB(prices);
    return { success: true, message: 'Precios actualizados correctamente' };
  } catch (error: any) {
    logger.error('[ReferencePriceService] Force update failed:', error);
    return { success: false, message: error.message || 'Error actualizando precios' };
  }
}

/**
 * Construye respuesta con precios por defecto (fallback)
 */
function buildFallbackResponse(): Record<string, any> {
  const result: Record<string, any> = {};

  for (const [category, config] of Object.entries(categoryConfig)) {
    const suggestions: Array<{ amount: number; description: string }> = [];

    for (const key of config.keys) {
      suggestions.push({
        amount: fallbackPrices[key] || 0,
        description: defaultDescriptions[key] || key
      });
    }

    result[category] = {
      name: config.name,
      icon: config.icon,
      percentageOptions: config.percentageOptions,
      suggestions
    };
  }

  return result;
}

/**
 * Inicializa los precios por defecto si la BD está vacía
 */
export async function initializeDefaultPrices(): Promise<void> {
  try {
    const count = await prisma.referencePrice.count({
      where: { country: COUNTRY_CODE }
    });

    if (count === 0) {
      logger.log('[ReferencePriceService] Initializing default prices...');

      for (const [category, config] of Object.entries(categoryConfig)) {
        for (const key of config.keys) {
          await prisma.referencePrice.create({
            data: {
              category,
              key,
              country: COUNTRY_CODE,
              amount: fallbackPrices[key] || 0,
              description: defaultDescriptions[key] || key,
              source: 'Default values'
            }
          });
        }
      }

      // Crear config
      await prisma.referencePriceConfig.upsert({
        where: { country: COUNTRY_CODE },
        update: {},
        create: {
          country: COUNTRY_CODE,
          cacheDays: DEFAULT_CACHE_DAYS,
          lastFullUpdate: null
        }
      });

      logger.log('[ReferencePriceService] Default prices initialized');
    }
  } catch (error) {
    logger.error('[ReferencePriceService] Error initializing default prices:', error);
  }
}
