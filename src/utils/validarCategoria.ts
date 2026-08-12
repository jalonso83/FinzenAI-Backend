import { prisma } from '../lib/prisma';
import { logger } from './logger';

/**
 * Resolución de una categoría a partir del nombre que dijo el usuario.
 *
 * ─── Por qué esto vive aquí y no en cada controlador ─────────────────────────
 *
 * Había TRES copias de esta función (zenioAgents, zenioV2 y zenio) y habían
 * divergido en cosas que el usuario nota:
 *
 *  1. Solo la de `zenioAgents` hacía coincidencia PARCIAL. En las otras dos,
 *     pedir "presupuesto de salario" fallaba si la categoría se llama "Salario y
 *     sueldos": funcionaba en el chat y fallaba en el onboarding, con el mismo
 *     texto.
 *  2. Cuando no encontraba nada, dos de ellas sugerían categorías de AMBOS
 *     tipos, contradiciendo su propio comentario.
 *  3. Dos tenían un comentario que afirmaba que, si el cliente no manda `type`,
 *     se cae a la búsqueda en base de datos. No ocurría: la lista filtrada
 *     quedaba vacía, no se entraba al `else`, y se devolvía "no encontrada"
 *     siempre.
 *
 * El bug de fondo que motivó todo esto (2026-08-09) fue que la rama de la lista
 * del cliente ignoraba el tipo pedido: "ponme un presupuesto de salario" resolvía
 * a "Salario" —categoría de INGRESO— y creaba un presupuesto de gasto sobre ella,
 * que se quedaba en 0 para siempre porque el recálculo solo suma gastos. Se
 * encontraron 6 así en producción.
 */

function normalizarTexto(texto: string): string {
  return texto.toLowerCase().trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

export interface ResultadoCategoria {
  valid: boolean;
  categoryId?: string;
  suggestions?: string[];
  error?: string;
}

/**
 * @param categoryName  Lo que dijo el usuario ("salario", "comida", ...)
 * @param expectedType  'gasto' | 'ingreso' | cualquier otra cosa = sin filtrar
 * @param categories    Lista que manda el cliente ({id, name, type}), opcional
 */
export async function validarCategoria(
  categoryName: string,
  expectedType: string,
  categories?: any[],
): Promise<ResultadoCategoria> {
  try {
    return await resolver(categoryName, expectedType, categories);
  } catch (error) {
    // Las tres copias originales envolvían todo en try/catch y devolvían un
    // fallo suave. Se conserva: un problema de base de datos no debe reventar
    // toda la conversación de Zenio.
    logger.error('[validarCategoria] Error resolviendo la categoría:', error);
    return { valid: false, error: 'No pude verificar la categoría en este momento. ¿Intentamos de nuevo?' };
  }
}

async function resolver(
  categoryName: string,
  expectedType: string,
  categories?: any[],
): Promise<ResultadoCategoria> {
  const normalized = normalizarTexto(categoryName || '');
  const typeFilter = expectedType === 'gasto' ? 'EXPENSE' : expectedType === 'ingreso' ? 'INCOME' : null;

  // 1. Lista del cliente, filtrada por tipo. Si el cliente no manda `type` en
  //    sus elementos, se deja vacía A PROPÓSITO para caer a la base de datos,
  //    que sí sabe el tipo de cada categoría.
  const listaCliente = (() => {
    if (!categories || categories.length === 0) return [];
    if (!typeFilter) return categories;
    return categories.filter((c: any) => c?.type).filter((c: any) => c.type === typeFilter);
  })();

  if (listaCliente.length > 0) {
    const exacta = listaCliente.find((c: any) => normalizarTexto(c.name) === normalized);
    if (exacta) return { valid: true, categoryId: exacta.id };

    const parciales = listaCliente.filter((c: any) =>
      normalizarTexto(c.name).includes(normalized) || normalized.includes(normalizarTexto(c.name)),
    );
    if (parciales.length === 1) return { valid: true, categoryId: parciales[0].id };
    if (parciales.length > 1) {
      const nombres = parciales.map((c: any) => c.name);
      return {
        valid: false,
        suggestions: nombres,
        error: `Hay varias categorías que encajan con "${categoryName}": ${nombres.join(', ')}. ¿Cuál de ellas?`,
      };
    }
    // Sin coincidencias: se sigue a la base de datos.
  }

  // 2. Base de datos, filtrando por tipo.
  const todas = await prisma.category.findMany({ where: { isDefault: true } });
  const candidatas = typeFilter ? todas.filter((c) => c.type === typeFilter) : todas;

  const exacta = candidatas.find((c) => normalizarTexto(c.name) === normalized);
  if (exacta) return { valid: true, categoryId: exacta.id };

  const parciales = candidatas.filter((c) =>
    normalizarTexto(c.name).includes(normalized) || normalized.includes(normalizarTexto(c.name)),
  );
  if (parciales.length === 1) return { valid: true, categoryId: parciales[0].id };

  // 3. No hay forma de resolverla: se sugieren SOLO las del tipo pedido.
  const nombres = candidatas.map((c) => c.name);
  return {
    valid: false,
    suggestions: nombres,
    error: `No se encontró la categoría "${categoryName}". Elige una de las siguientes: ${nombres.join(', ')}`,
  };
}
