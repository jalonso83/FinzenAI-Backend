/**
 * Definiciones de Tools de Zenio para la Responses API
 * Extraídas del Assistant asst_nFUU8Z3MaqnoonSXG0UHMokK
 * Fecha de backup: 2026-03-23
 *
 * Estas definiciones se pasan directamente a openai.responses.create({ tools: [...] })
 *
 * IMPORTANTE: El formato de FunctionTool en Responses API requiere:
 *   { type: 'function', name, description, parameters, strict }
 * El campo `strict` es OBLIGATORIO. Usamos strict: false para permitir
 * keywords como format, minimum, maximum, minProperties en los schemas.
 * Sin strict, el SDK defaults a true y las tools se ignoran silenciosamente
 * si el schema no cumple con las reglas de structured outputs.
 */

export const ZENIO_FUNCTION_TOOLS = [
  {
    type: 'function' as const,
    name: 'manage_budget_record',
    description: 'Inserta, actualiza, elimina o lista presupuestos. Para listar, usa filtros_busqueda para criterios específicos como límite, categoría, recurrencia, monto. Para update/delete especifica category y previous_amount.',
    strict: false,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        operation: {
          type: 'string',
          description: 'Tipo de operación: insert, update, delete o list',
          enum: ['insert', 'update', 'delete', 'list'],
        },
        category: {
          type: 'string',
          description: 'Categoría del presupuesto (requerido para insert/update/delete)',
        },
        recurrence: {
          type: 'string',
          description: 'Frecuencia del presupuesto: semanal, mensual o anual',
          enum: ['semanal', 'mensual', 'anual'],
        },
        amount: {
          type: 'number',
          description: 'Monto para insert o update',
        },
        previous_amount: {
          type: 'number',
          description: 'Monto anterior (requerido para update o delete)',
        },
        filtros_busqueda: {
          type: 'object',
          description: 'Filtros específicos para la operación list.',
          additionalProperties: false,
          properties: {
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: 100,
              description: 'Número máximo de presupuestos a retornar',
            },
            category: {
              type: 'string',
              description: 'Filtrar por categoría específica',
            },
            recurrence: {
              type: 'string',
              enum: ['semanal', 'mensual', 'anual'],
              description: 'Filtrar por frecuencia específica',
            },
            min_amount: {
              type: 'number',
              description: 'Monto mínimo del presupuesto',
            },
            max_amount: {
              type: 'number',
              description: 'Monto máximo del presupuesto',
            },
          },
        },
      },
      required: ['operation'],
    },
  },
  {
    type: 'function' as const,
    name: 'manage_transaction_record',
    description: 'Inserta, actualiza, elimina o lista transacciones. Para listar, usa filtros_busqueda para criterios específicos como límite, tipo, categoría, fecha. Para update/delete usa criterios_identificacion con al menos dos campos.',
    strict: false,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['operation'],
      properties: {
        operation: {
          type: 'string',
          description: 'Tipo de operación (insert, update, delete, list)',
          enum: ['insert', 'update', 'delete', 'list'],
        },
        transaction_data: {
          type: 'object',
          description: 'Datos de la transacción nueva o para actualizar',
          additionalProperties: false,
          properties: {
            amount: {
              type: 'number',
              description: 'Monto de la transacción',
            },
            type: {
              type: 'string',
              enum: ['gasto', 'ingreso'],
              description: 'Tipo de transacción',
            },
            category: {
              type: 'string',
              description: 'Categoría de la transacción',
            },
            description: {
              type: 'string',
              description: 'Descripción de la transacción',
            },
            date: {
              type: 'string',
              format: 'date',
              description: 'Fecha (YYYY-MM-DD)',
            },
          },
        },
        criterios_identificacion: {
          type: 'object',
          description: 'Criterios para localizar una transacción existente (mínimo 2 campos para update/delete)',
          additionalProperties: false,
          minProperties: 2,
          properties: {
            amount: {
              type: 'number',
              description: 'Monto original',
            },
            type: {
              type: 'string',
              enum: ['gasto', 'ingreso'],
              description: 'Tipo original',
            },
            category: {
              type: 'string',
              description: 'Categoría original',
            },
            date: {
              type: 'string',
              format: 'date',
              description: 'Fecha original (YYYY-MM-DD)',
            },
          },
        },
        filtros_busqueda: {
          type: 'object',
          description: 'Filtros específicos para la operación list.',
          additionalProperties: false,
          properties: {
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: 100,
              description: 'Número máximo de transacciones a retornar',
            },
            type: {
              type: 'string',
              enum: ['gasto', 'ingreso'],
              description: 'Filtrar solo gastos o ingresos',
            },
            category: {
              type: 'string',
              description: 'Filtrar por categoría específica',
            },
            date_from: {
              type: 'string',
              format: 'date',
              description: 'Fecha inicio del rango (YYYY-MM-DD)',
            },
            date_to: {
              type: 'string',
              format: 'date',
              description: 'Fecha fin del rango (YYYY-MM-DD)',
            },
            date: {
              type: 'string',
              format: 'date',
              description: 'Fecha específica (YYYY-MM-DD)',
            },
          },
        },
      },
    },
  },
  {
    type: 'function' as const,
    name: 'onboarding_financiero',
    description: 'Recolecta las respuestas del usuario para su onboarding financiero y las envía al backend. Solo debe enviar una sola respuesta para cada una de las preguntas.',
    strict: false,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        nombre_usuario: {
          type: 'string',
          description: 'Nombre del usuario para saludo personalizado',
        },
        meta_financiera: {
          type: 'array',
          items: { type: 'string' },
          description: 'Principal meta financiera al empezar a usar FinZen AI. Una o dos metas principales.',
        },
        desafio_financiero: {
          type: 'string',
          description: 'Mayor desafío financiero en este momento.',
        },
        habito_ahorro: {
          type: 'string',
          description: 'Si tiene el hábito de ahorrar parte de sus ingresos.',
        },
        fondo_emergencia: {
          type: 'string',
          description: 'Si cuenta con un fondo para emergencias.',
        },
        sentir_financiero: {
          type: 'string',
          description: 'Sentir general sobre su situación financiera actual.',
        },
        rango_ingresos: {
          type: 'string',
          description: 'Rango de ingresos mensuales netos.',
        },
      },
      required: [
        'nombre_usuario',
        'meta_financiera',
        'desafio_financiero',
        'habito_ahorro',
        'fondo_emergencia',
      ],
    },
  },
  {
    type: 'function' as const,
    name: 'manage_goal_record',
    description: 'Inserta, actualiza, elimina o lista metas de ahorro. Para listar, usa filtros_busqueda para criterios específicos como límite, categoría, prioridad, monto. Para update/delete especifica criterios_identificacion.',
    strict: false,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['operation'],
      properties: {
        operation: {
          type: 'string',
          enum: ['insert', 'update', 'delete', 'list'],
          description: 'Tipo de operación a realizar',
        },
        goal_data: {
          type: 'object',
          description: 'Datos de la meta nueva o actualizada',
          additionalProperties: false,
          properties: {
            name: {
              type: 'string',
              description: 'Nombre de la meta',
            },
            target_amount: {
              type: 'number',
              description: 'Monto objetivo de la meta',
            },
            category: {
              type: 'string',
              description: 'Categoría de la meta',
            },
            due_date: {
              type: 'string',
              format: 'date',
              description: 'Fecha límite para lograr la meta (YYYY-MM-DD)',
            },
            monthly_type: {
              type: 'string',
              enum: ['porcentaje', 'fijo'],
              description: 'Tipo de objetivo mensual',
            },
            monthly_value: {
              type: 'number',
              description: 'Valor mensual (porcentaje o monto fijo)',
            },
            priority: {
              type: 'string',
              enum: ['Alta', 'Media', 'Baja'],
              description: 'Nivel de prioridad de la meta',
            },
            description: {
              type: 'string',
              description: 'Descripción adicional de la meta',
            },
          },
        },
        criterios_identificacion: {
          type: 'object',
          description: 'Criterios para identificar la meta existente (requerido para UPDATE/DELETE)',
          additionalProperties: false,
          minProperties: 1,
          properties: {
            name: {
              type: 'string',
              description: 'Nombre original de la meta',
            },
            category: {
              type: 'string',
              description: 'Categoría original de la meta',
            },
            target_amount: {
              type: 'number',
              description: 'Monto objetivo original',
            },
            due_date: {
              type: 'string',
              format: 'date',
              description: 'Fecha límite original de la meta (YYYY-MM-DD)',
            },
          },
        },
        filtros_busqueda: {
          type: 'object',
          description: 'Filtros específicos para la operación list.',
          additionalProperties: false,
          properties: {
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: 100,
              description: 'Número máximo de metas a retornar',
            },
            category: {
              type: 'string',
              description: 'Filtrar por categoría específica',
            },
            priority: {
              type: 'string',
              enum: ['Alta', 'Media', 'Baja'],
              description: 'Filtrar por nivel de prioridad',
            },
            min_amount: {
              type: 'number',
              description: 'Monto objetivo mínimo',
            },
            max_amount: {
              type: 'number',
              description: 'Monto objetivo máximo',
            },
            due_date_from: {
              type: 'string',
              format: 'date',
              description: 'Metas que vencen desde esta fecha (YYYY-MM-DD)',
            },
            due_date_to: {
              type: 'string',
              format: 'date',
              description: 'Metas que vencen hasta esta fecha (YYYY-MM-DD)',
            },
            status: {
              type: 'string',
              enum: ['activa', 'vencida', 'completada'],
              description: 'Estado de la meta',
            },
          },
        },
      },
    },
  },
  {
    type: 'function' as const,
    name: 'list_categories',
    description: 'Devuelve un array con todas las categorías válidas de un módulo (presupuestos, transacciones, metas).',
    strict: false,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['module'],
      properties: {
        module: {
          type: 'string',
          enum: ['presupuestos', 'transacciones', 'metas'],
          description: 'Módulo del cual listar categorías',
        },
      },
    },
  },
];

/**
 * Tools adicionales del Assistant original (no son function calls)
 * Se incluyen como referencia para la migración
 */
export const ZENIO_BUILTIN_TOOLS = {
  file_search: {
    vector_store_ids: ['vs_685da89f2ce4819193d9d9fc40b7f5c1'],
    ranking_options: {
      ranker: 'default_2024_08_21',
      score_threshold: 0.0,
    },
  },
  code_interpreter: {
    enabled: true,
    file_ids: [],
  },
};
