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
const CRITERIOS_GASTO = {
  type: 'object',
  description: 'Para identificar un gasto YA registrado del usuario (monto, categoría, fecha).',
  additionalProperties: false,
  properties: {
    amount: { type: 'number', description: 'Monto del gasto' },
    category: { type: 'string', description: 'Categoría del gasto' },
    date: { type: 'string', format: 'date', description: 'Fecha del gasto (YYYY-MM-DD)' },
  },
};

/**
 * Las tools compartidas con zenioV2 se clonan y se les añade lo de compartidos
 * SOLO aquí: zenioV2 no sabe manejarlo y no debe verlo.
 */
function conCompartidos(tool: any): any {
  if (tool.name === 'manage_transaction_record') {
    const props = tool.parameters.properties;
    return {
      ...tool,
      parameters: {
        ...tool.parameters,
        properties: {
          ...props,
          transaction_data: {
            ...props.transaction_data,
            properties: {
              ...props.transaction_data.properties,
              compartido: {
                type: 'boolean',
                description: 'Solo para gastos en una categoría que el usuario comparte. Por defecto true (cuenta en el presupuesto compartido). false si el usuario dice que ese gasto es personal.',
              },
            },
          },
        },
      },
    };
  }
  if (tool.name === 'manage_budget_record') {
    return {
      ...tool,
      parameters: {
        ...tool.parameters,
        properties: {
          ...tool.parameters.properties,
          alcance: {
            type: 'string',
            enum: ['personal', 'compartido'],
            description: 'Solo si el usuario tiene un presupuesto personal y uno compartido de la misma categoría: cuál quiere cambiar o borrar.',
          },
        },
      },
    };
  }
  return tool;
}

const APORTAR_A_META = {
    type: 'function' as const,
    name: 'aportar_a_meta',
    description: 'Registra un aporte (dinero que el usuario puso) a una meta de ahorro suya o compartida con él. Requiere PREVIEW y confirmación antes de llamarla.',
    strict: false,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['amount'],
      properties: {
        goal_name: { type: 'string', description: 'Nombre (o parte del nombre) de la meta' },
        amount: { type: 'number', description: 'Monto del aporte, en la moneda del usuario' },
      },
    },
  };

/**
 * Asistente para quien NO está en ningún compartido: sin nada de compartidos
 * en las herramientas. Con el campo "compartido" a la vista, el modelo llegó a
 * preguntarle "¿personal o compartido?" a quien no comparte nada.
 */
export const ASISTENTE_TOOLS_BASE = [...ZENIO_FUNCTION_TOOLS, APORTAR_A_META];

/** Asistente para quien está en algún compartido. */
export const ASISTENTE_TOOLS = [
  ...ZENIO_FUNCTION_TOOLS.map(conCompartidos),
  APORTAR_A_META,
  {
    type: 'function' as const,
    name: 'manage_shared_record',
    description: 'Presupuestos y metas compartidos con otras personas: ver el detalle, gastos automáticos por confirmar, confirmarlos, sacar un gasto del compartido o volver a contarlo, e invitar a alguien (solo el dueño).',
    strict: false,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['operation'],
      properties: {
        operation: {
          type: 'string',
          enum: ['ver', 'por_confirmar', 'confirmar', 'sacar', 'volver_a_contar', 'invitar'],
          description: 'ver: detalle de lo compartido · por_confirmar: mis gastos automáticos sin confirmar · confirmar: confirmarlos · sacar / volver_a_contar: un gasto mío deja de contar (o vuelve) en el compartido · invitar: crear invitación',
        },
        criterios_identificacion: CRITERIOS_GASTO,
        todos: { type: 'boolean', description: 'confirmar: true para confirmar todos los pendientes' },
        tipo: { type: 'string', enum: ['presupuesto', 'meta'], description: 'invitar: qué se comparte' },
        nombre: { type: 'string', description: 'invitar: nombre o categoría del presupuesto, o nombre de la meta' },
      },
    },
  },
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
  },
];
