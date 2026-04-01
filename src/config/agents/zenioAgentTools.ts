/**
 * Zenio Agent Tools — Herramientas disponibles por agente
 * Cada agente recibe SOLO las tools que necesita
 */

import { ZENIO_FUNCTION_TOOLS } from '../zenioTools';
import { ZENIO_VECTOR_STORE_ID } from '../zenioPrompt';

/**
 * Tools para el Agente Asistente
 * Tiene acceso a TODAS las funciones de gestión
 */
export const ASISTENTE_TOOLS = [
  ...ZENIO_FUNCTION_TOOLS,
];

/**
 * Tools para el Agente Educativo
 * Solo tiene file_search para buscar en el vector store
 * NO tiene funciones de gestión
 */
/**
 * Tools para el Agente Analista
 * Solo tiene una función de lectura que obtiene el snapshot financiero completo
 * NO tiene funciones de gestión (no crea, modifica ni elimina)
 */
export const ANALISTA_TOOLS = [
  {
    type: 'function' as const,
    name: 'analizar_finanzas',
    description: 'Obtiene un snapshot completo de las finanzas del usuario: transacciones del mes actual y anterior, presupuestos activos con % de uso, metas activas con progreso, y perfil de onboarding. Usa esta función para responder cualquier pregunta de análisis.',
    strict: false,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        periodo: {
          type: 'string',
          description: 'Período a analizar: "mes_actual", "mes_anterior", "ambos". Default: "ambos".',
          enum: ['mes_actual', 'mes_anterior', 'ambos'],
        },
      },
      required: [],
    },
  },
];

export const EDUCATIVO_TOOLS: any[] = [
  {
    type: 'file_search' as const,
    vector_store_ids: [ZENIO_VECTOR_STORE_ID],
    ranking_options: {
      ranker: 'default_2024_08_21',
      score_threshold: 0.0,
    },
  },
];
