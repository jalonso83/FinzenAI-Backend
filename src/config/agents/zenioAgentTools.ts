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
