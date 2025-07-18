import axios from 'axios';
import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const API_KEY = process.env.OPENAI_API_KEY;
const ASSISTANT_ID = process.env.OPENAI_ASSISTANT_ID;
const OPENAI_BASE_URL = 'https://api.openai.com/v1';
const OPENAI_HEADERS = {
  Authorization: `Bearer ${API_KEY}`,
  'OpenAI-Beta': 'assistants=v2'
};

// Tipos para las peticiones
interface ChatRequest {
  message: string;
  threadId?: string;
}

interface ChatResponse {
  message: string;
  threadId: string;
  messageId: string;
}

// Función para formatear fecha local en YYYY-MM-DD
function formatearFechaYYYYMMDD(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// Función para reemplazar expresiones temporales por la fecha real
function reemplazarExpresionesTemporalesPorFecha(texto: string): string {
  // Obtener fecha actual en zona horaria de República Dominicana
  const ahora = new Date();
  
  // Calcular offset para República Dominicana (UTC-4)
  // Esto asegura que "hoy" sea el día actual en RD, no en UTC
  const offsetRD = -4; // UTC-4 para República Dominicana
  const utc = ahora.getTime() + (ahora.getTimezoneOffset() * 60000);
  const fechaRD = new Date(utc + (offsetRD * 60 * 60 * 1000));
  
  // Formatear fecha actual en YYYY-MM-DD (local RD)
  const fechaISO = formatearFechaYYYYMMDD(fechaRD);
  
  // Calcular otras fechas relativas
  const ayer = new Date(fechaRD);
  ayer.setDate(fechaRD.getDate() - 1);
  const fechaAyer = formatearFechaYYYYMMDD(ayer);
  
  const manana = new Date(fechaRD);
  manana.setDate(fechaRD.getDate() + 1);
  const fechaManana = formatearFechaYYYYMMDD(manana);
  
  const pasadoManana = new Date(fechaRD);
  pasadoManana.setDate(fechaRD.getDate() + 2);
  const fechaPasadoManana = formatearFechaYYYYMMDD(pasadoManana);
  
  const anteayer = new Date(fechaRD);
  anteayer.setDate(fechaRD.getDate() - 2);
  const fechaAnteayer = formatearFechaYYYYMMDD(anteayer);

  // Si el texto es exactamente una expresión temporal, devolver la fecha directamente
  const textoLimpio = texto.trim().toLowerCase();
  if (textoLimpio === 'hoy' || textoLimpio === 'enhoy') {
    return fechaISO;
  }
  if (textoLimpio === 'ayer') {
    return fechaAyer;
  }
  if (textoLimpio === 'mañana' || textoLimpio === 'manana') {
    return fechaManana;
  }
  if (textoLimpio === 'anteayer') {
    return fechaAnteayer;
  }
  if (textoLimpio === 'pasado mañana' || textoLimpio === 'pasado manana') {
    return fechaPasadoManana;
  }

  // Si no es una expresión exacta, aplicar reemplazos en el texto
  return texto
    // Hoy
    .replace(/\benhoy\b/gi, fechaISO)
    .replace(/\benhoy día\b/gi, fechaISO)
    .replace(/\benhoy mismo\b/gi, fechaISO)
    .replace(/\benhoy en día\b/gi, fechaISO)
    .replace(/\ben el día de hoy\b/gi, fechaISO)
    .replace(/\bhoy\b/gi, fechaISO)
    // Ayer
    .replace(/\ben el día de ayer\b/gi, fechaAyer)
    .replace(/\bayer\b/gi, fechaAyer)
    // Anteayer
    .replace(/\banteayer\b/gi, fechaAnteayer)
    // Mañana
    .replace(/\bmañana\b/gi, fechaManana)
    .replace(/\bmanana\b/gi, fechaManana)
    // Pasado mañana
    .replace(/\bpasado mañana\b/gi, fechaPasadoManana)
    .replace(/\bpasado manana\b/gi, fechaPasadoManana);
}

// Función para normalizar fechas a formato YYYY-MM-DD
function normalizarFecha(fecha: string): string | null {
  if (!fecha) return null;
  // 1. Si ya es YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return fecha;
  // 2. Si es YYYY/MM/DD
  if (/^\d{4}\/\d{2}\/\d{2}$/.test(fecha)) return fecha.replace(/\//g, '-');
  // 3. Si es DD/MM/YYYY
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(fecha)) {
    const [d, m, y] = fecha.split('/');
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  // 4. Si es DD-MM-YYYY
  if (/^\d{2}-\d{2}-\d{4}$/.test(fecha)) {
    const [d, m, y] = fecha.split('-');
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  // 5. Si es fecha en español: '12 de julio de 2025'
  const meses = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
  const match = fecha.match(/(\d{1,2})\s*de\s*([a-záéíóúñ]+)\s*de\s*(\d{4})/i);
  if (match) {
    const d = match[1].padStart(2, '0');
    const m = (meses.findIndex(mes => mes === match[2].toLowerCase()) + 1).toString().padStart(2, '0');
    const y = match[3];
    return `${y}-${m}-${d}`;
  }
  // 6. Si es YYYY.MM.DD
  if (/^\d{4}\.\d{2}\.\d{2}$/.test(fecha)) return fecha.replace(/\./g, '-');
  // 7. Si es DD.MM.YYYY
  if (/^\d{2}\.\d{2}\.\d{4}$/.test(fecha)) {
    const [d, m, y] = fecha.split('.');
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  // 8. Si es YYYYMMDD
  if (/^\d{8}$/.test(fecha)) return `${fecha.slice(0,4)}-${fecha.slice(4,6)}-${fecha.slice(6,8)}`;
  return null;
}

// Función para procesar fechas en datos de transacción
function procesarFechasEnDatosTransaccion(data: any): any {
  if (!data) return data;
  
  const datosProcesados = { ...data };
  
  // Procesar fecha si existe
  if (datosProcesados.date && typeof datosProcesados.date === 'string') {
    // Primero intentar normalizar la fecha
    let fechaNormalizada = normalizarFecha(datosProcesados.date);
    
    // Si no se pudo normalizar, intentar con expresiones temporales
    if (!fechaNormalizada) {
      fechaNormalizada = reemplazarExpresionesTemporalesPorFecha(datosProcesados.date);
      // Si la función de reemplazo devolvió el mismo texto, significa que no encontró expresiones temporales
      if (fechaNormalizada === datosProcesados.date) {
        fechaNormalizada = null;
      }
    }
    
    if (fechaNormalizada) {
      console.log(`[Zenio] Fecha procesada: "${datosProcesados.date}" -> "${fechaNormalizada}"`);
      datosProcesados.date = fechaNormalizada;
    }
  }
  
  return datosProcesados;
}

// Función para validar datos de transacción
function validateTransactionData(data: any): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  
  // Validar amount
  if (!data.amount) {
    errors.push('Amount es requerido');
  } else if (isNaN(parseFloat(data.amount)) || parseFloat(data.amount) <= 0) {
    errors.push('Amount debe ser un número positivo');
  }
  
  // Validar type
  if (!data.type) {
    errors.push('Type es requerido');
  } else if (!['gasto', 'ingreso'].includes(data.type)) {
    errors.push('Type debe ser "gasto" o "ingreso"');
  }
  
  // Validar category
  if (!data.category) {
    errors.push('Category es requerida');
  }
  
  // Validar date (opcional, si no se proporciona se usará la fecha actual)
  if (data.date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data.date)) {
      errors.push('Date debe estar en formato YYYY-MM-DD');
    } else {
      // Validar que la fecha sea válida y razonable
      const dateObj = new Date(data.date);
      if (isNaN(dateObj.getTime())) {
        errors.push('Date debe ser una fecha válida');
      } else {
        const fechaMinima = new Date('2020-01-01');
        if (dateObj < fechaMinima) {
          errors.push('Date no puede ser anterior al año 2020');
        }
      }
    }
  }
  
  return { valid: errors.length === 0, errors };
}

// Función para validar criterios de identificación
function validateCriterios(criterios: any): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const validFields = ['amount', 'category', 'date', 'type', 'description', 'id'];
  
  if (!criterios || typeof criterios !== 'object') {
    errors.push('Criterios de identificación es requerido y debe ser un objeto');
    return { valid: false, errors };
  }
  
  const providedFields = Object.keys(criterios);
  
  if (providedFields.length < 2) {
    errors.push('Se requieren al menos 2 criterios de identificación');
  }
  
  const invalidFields = providedFields.filter(field => !validFields.includes(field));
  if (invalidFields.length > 0) {
    errors.push(`Campos inválidos en criterios: ${invalidFields.join(', ')}`);
  }
  
  // Validar que los valores no estén vacíos
  providedFields.forEach(field => {
    if (criterios[field] === null || criterios[field] === undefined || criterios[field] === '') {
      errors.push(`El criterio ${field} no puede estar vacío`);
    }
  });
  
  return { valid: errors.length === 0, errors };
}

// Función para validar categoría contra la base de datos o lista proporcionada
async function validateCategory(categoryName: string, type: string, availableCategories?: string[]): Promise<{ valid: boolean; error?: string; categoryId?: string; suggestions?: string[] }> {
  try {
    if (availableCategories && availableCategories.length > 0) {
      // Usar la lista proporcionada por el frontend
      const dbType = type === 'gasto' ? 'EXPENSE' : 'INCOME';
      
      // Buscar la categoría en la lista proporcionada (case insensitive)
      const foundCategory = availableCategories.find(cat => 
        cat.toLowerCase() === categoryName.toLowerCase()
      );
      
      if (foundCategory) {
        // Obtener el ID de la categoría de la base de datos
        const category = await prisma.category.findFirst({
          where: {
            name: { equals: foundCategory, mode: 'insensitive' },
            type: dbType
          }
        });
        if (category) {
          return { valid: true, categoryId: category.id };
        }
      } else {
        // Filtrar categorías por tipo (asumiendo que las categorías del frontend son de gastos)
        const suggestions = availableCategories;
        return {
          valid: false,
          error: `No se encontró la categoría "${categoryName}". Elige una de las siguientes: ${suggestions.join(', ')}`,
          suggestions: suggestions
        };
      }
    } else {
      // Comportamiento original: consultar base de datos
      const dbType = type === 'gasto' ? 'EXPENSE' : 'INCOME';
      const category = await prisma.category.findFirst({
        where: {
          name: { equals: categoryName, mode: 'insensitive' },
          type: dbType
        }
      });
      if (category) {
        return { valid: true, categoryId: category.id };
      } else {
        // Sugerir categorías válidas
        const suggestions = await prisma.category.findMany({
          where: { type: dbType },
          select: { name: true }
        });
        return {
          valid: false,
          error: `No se encontró la categoría "${categoryName}". Elige una de las siguientes: ${suggestions.map(c => c.name).join(', ')}`,
          suggestions: suggestions.map(c => c.name)
        };
      }
    }
      } catch (error) {
      return { valid: false, error: 'Error al validar la categoría' };
    }
    
    // Return por defecto
    return { valid: false, error: 'Categoría no válida' };
  }

// Función para obtener categorías válidas
async function getValidCategories(type: 'EXPENSE' | 'INCOME'): Promise<string> {
  try {
    const categories = await prisma.category.findMany({
      where: { type },
      select: { name: true }
    });
    return categories.map(cat => cat.name).join(', ');
  } catch (error) {
    return 'Error al obtener categorías';
  }
}

// Función para validar datos de presupuesto
function validateBudgetData(data: any): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  
  // Validar name
  if (!data.name) {
    errors.push('Name es requerido');
  }
  
  // Validar amount
  if (!data.amount) {
    errors.push('Amount es requerido');
  } else if (isNaN(parseFloat(data.amount)) || parseFloat(data.amount) <= 0) {
    errors.push('Amount debe ser un número positivo');
  }
  
  // Validar category
  if (!data.category) {
    errors.push('Category es requerida');
  }
  
  // Validar period
  if (!data.period) {
    errors.push('Period es requerido');
  } else if (!['monthly', 'weekly', 'yearly'].includes(data.period)) {
    errors.push('Period debe ser "monthly", "weekly" o "yearly"');
  }
  
  // Validar start_date
  if (!data.start_date) {
    errors.push('Start_date es requerida');
  } else if (!/^\d{4}-\d{2}-\d{2}$/.test(data.start_date)) {
    errors.push('Start_date debe estar en formato YYYY-MM-DD');
  } else {
    const dateObj = new Date(data.start_date);
    if (isNaN(dateObj.getTime())) {
      errors.push('Start_date debe ser una fecha válida');
    }
  }
  
  // Validar end_date
  if (!data.end_date) {
    errors.push('End_date es requerida');
  } else if (!/^\d{4}-\d{2}-\d{2}$/.test(data.end_date)) {
    errors.push('End_date debe estar en formato YYYY-MM-DD');
  } else {
    const dateObj = new Date(data.end_date);
    if (isNaN(dateObj.getTime())) {
      errors.push('End_date debe ser una fecha válida');
    }
  }
  
  // Validar que start_date sea antes que end_date
  if (data.start_date && data.end_date) {
    const startDate = new Date(data.start_date);
    const endDate = new Date(data.end_date);
    if (startDate >= endDate) {
      errors.push('Start_date debe ser antes que end_date');
    }
  }
  
  // Validar alert_percentage si se proporciona
  if (data.alert_percentage !== undefined) {
    const alertPercent = parseFloat(data.alert_percentage);
    if (isNaN(alertPercent) || alertPercent < 0 || alertPercent > 100) {
      errors.push('Alert_percentage debe ser un número entre 0 y 100');
    }
  }
  
  return { valid: errors.length === 0, errors };
}

// Función para validar criterios de identificación de presupuestos
function validateBudgetCriterios(criterios: any): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const validFields = ['name', 'category', 'amount', 'period', 'id'];
  
  if (!criterios || typeof criterios !== 'object') {
    errors.push('Criterios de identificación es requerido y debe ser un objeto');
    return { valid: false, errors };
  }
  
  const providedFields = Object.keys(criterios);
  
  if (providedFields.length < 1) {
    errors.push('Se requiere al menos 1 criterio de identificación');
  }
  
  const invalidFields = providedFields.filter(field => !validFields.includes(field));
  if (invalidFields.length > 0) {
    errors.push(`Campos inválidos en criterios: ${invalidFields.join(', ')}`);
  }
  
  // Validar que los valores no estén vacíos
  providedFields.forEach(field => {
    if (criterios[field] === null || criterios[field] === undefined || criterios[field] === '') {
      errors.push(`El criterio ${field} no puede estar vacío`);
    }
  });
  
  return { valid: errors.length === 0, errors };
}

// Función para validar datos de meta
function validateGoalData(data: any): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  
  // Validar name
  if (!data.name) {
    errors.push('Name es requerido');
  } else if (typeof data.name !== 'string' || data.name.trim().length === 0) {
    errors.push('Name debe ser un texto válido');
  }
  
  // Validar target_amount
  if (!data.target_amount) {
    errors.push('Target_amount es requerido');
  } else if (isNaN(parseFloat(data.target_amount)) || parseFloat(data.target_amount) <= 0) {
    errors.push('Target_amount debe ser un número positivo');
  }
  
  // Validar category
  if (!data.category) {
    errors.push('Category es requerida');
  }
  
  // Validar monthly_type
  if (data.monthly_type && !['porcentaje', 'fijo'].includes(data.monthly_type)) {
    errors.push('Monthly_type debe ser "porcentaje" o "fijo"');
  }
  
  // Validar monthly_value
  if (data.monthly_value) {
    if (isNaN(parseFloat(data.monthly_value)) || parseFloat(data.monthly_value) <=0) {
      errors.push('Monthly_value debe ser un número positivo');
    }
    if (data.monthly_type === 'porcentaje' && parseFloat(data.monthly_value) > 100) {
      errors.push('Monthly_value no puede ser mayor a 100%');
    }
  }
  
  // Validar due_date (opcional)
  if (data.due_date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data.due_date)) {
      errors.push('Due_date debe estar en formato YYYY-MM-DD');
    } else {
      const dateObj = new Date(data.due_date);
      if (isNaN(dateObj.getTime())) {
        errors.push('Due_date debe ser una fecha válida');
      } else {
        const today = new Date();
        today.setHours(0,0, 0);
        if (dateObj < today) {
          errors.push('Due_date no puede ser una fecha pasada');
        }
      }
    }
  }
  
  // Validar priority
  if (data.priority && !['Alta', 'Media', 'Baja'].includes(data.priority)) {
    errors.push('Priority debe ser "Alta", "Media" o "Baja"');
  }
  
  return { valid: errors.length === 0, errors };
}

// Función para validar criterios de identificación de metas
function validateGoalCriterios(criterios: any): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const validFields = ['name', 'category', 'target_amount', 'due_date'];
  
  if (!criterios || typeof criterios !== 'object') {
    errors.push('Criterios de identificación es requerido y debe ser un objeto');
    return { valid: false, errors };
  }
  
  const providedFields = Object.keys(criterios);
  
  if (providedFields.length < 1) {
    errors.push('Se requiere al menos 1 criterio de identificación');
  }
  
  const invalidFields = providedFields.filter(field => !validFields.includes(field));
  if (invalidFields.length > 0) {
    errors.push(`Campos inválidos en criterios: ${invalidFields.join(', ')}`);
  }
  
  // Validar que los valores no estén vacíos
  providedFields.forEach(field => {
    if (criterios[field] === null || criterios[field] === undefined || criterios[field] === '') {
      errors.push(`El criterio ${field} no puede estar vacío`);
    }
  });
  
  return { valid: errors.length === 0, errors };
}

// Función para esperar con backoff exponencial
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Función para hacer polling del run con backoff exponencial
async function pollRunStatus(threadId: string, runId: string, maxRetries: number = 30): Promise<any> {
  let retries = 0;
  let backoffMs = 1000; // 1 segundo inicial

  while (retries < maxRetries) {
    try {
      const response = await axios.get(
        `${OPENAI_BASE_URL}/threads/${threadId}/runs/${runId}`,
        { headers: OPENAI_HEADERS }
      );

      const run = response.data;
      console.log(`[Zenio] Run status: ${run.status} (intento ${retries + 1}/${maxRetries})`);

      // Si el run está completado, devolver
      if (run.status === 'completed') {
        return run;
      }

      // Si requiere acción (tool calls), devolver
      if (run.status === 'requires_action') {
        return run;
      }

      // Si falló o expiró, lanzar error
      if (run.status === 'failed' || run.status === 'expired') {
        throw new Error(`Run ${run.status}: ${run.last_error?.message || 'Error desconocido'}`);
      }

      // Si está en progreso o en cola, esperar y reintentar
      if (run.status === 'in_progress' || run.status === 'queued') {
        await sleep(backoffMs);
        retries++;
        // Backoff exponencial con máximo de 5 segundos
        backoffMs = Math.min(backoffMs * 1.5, 5000);
        continue;
      }

      // Estado inesperado
      throw new Error(`Estado de run inesperado: ${run.status}`);

    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 429) {
        // Rate limit, esperar más tiempo
        console.log('[Zenio] Rate limit detectado, esperando...');
        await sleep(backoffMs * 2);
        retries++;
        backoffMs = Math.min(backoffMs * 2, 10000);
        continue;
      }
      
      if (retries === maxRetries - 1) {
        throw error;
      }
      
      console.log(`[Zenio] Error en polling, reintentando... (${retries + 1}/${maxRetries})`);
      await sleep(backoffMs);
      retries++;
      backoffMs = Math.min(backoffMs * 1.5, 5000);
    }
  }

  throw new Error(`Timeout: El run no se completó después de ${maxRetries} intentos`);
}

// Función para ejecutar tool calls y enviar resultados
async function executeToolCalls(threadId: string, runId: string, toolCalls: any[], userId: string, userName: string, categories?: string[]): Promise<any> {
  const toolOutputs = [];
  const executedActions: any[] = [];

  for (const toolCall of toolCalls) {
    const functionName = toolCall.function.name;
    const functionArgs = JSON.parse(toolCall.function.arguments);

    console.log(`[Zenio] Ejecutando función: ${functionName}`, functionArgs);

    try {
      let result: any = null;

      // Ejecutar la función correspondiente
      switch (functionName) {
        case 'onboarding_financiero':
          result = await executeOnboardingFinanciero(functionArgs, userId, userName, categories);
          break;
        case 'manage_transaction_record':
          result = await executeManageTransactionRecord(functionArgs, userId, categories);
          break;
        case 'manage_budget_record':
          result = await executeManageBudgetRecord(functionArgs, userId, categories);
          break;
        case 'manage_goal_record':
          result = await executeManageGoalRecord(functionArgs, userId, categories);
          break;
        default:
          throw new Error(`Función no soportada: ${functionName}`);
      }

      // Guardar la acción ejecutada para el frontend
      if (result && result.action) {
        executedActions.push({
          action: result.action,
          data: result
        });
      }

      toolOutputs.push({
        tool_call_id: toolCall.id,
        output: JSON.stringify(result)
      });

    } catch (error) {
      console.error(`[Zenio] Error ejecutando ${functionName}:`, error);
      toolOutputs.push({
        tool_call_id: toolCall.id,
        output: JSON.stringify({
          error: true,
          message: error instanceof Error ? error.message : 'Error desconocido'
        })
      });
    }
  }

  // Enviar resultados a OpenAI
  console.log('[Zenio] Enviando tool outputs a OpenAI...');
  await axios.post(
    `${OPENAI_BASE_URL}/threads/${threadId}/runs/${runId}/submit_tool_outputs`,
    {
      tool_outputs: toolOutputs
    },
    { headers: { ...OPENAI_HEADERS, 'Content-Type': 'application/json' } }
  );

  // Hacer polling hasta que el run termine
  console.log('[Zenio] Haciendo polling después de submit_tool_outputs...');
  const finalRun = await pollRunStatus(threadId, runId);

  // Devolver tanto el run como las acciones ejecutadas
  return {
    run: finalRun,
    executedActions
  };
}

// Función para ejecutar onboarding_financiero
async function executeOnboardingFinanciero(args: any, userId: string, userName: string, categories?: string[]): Promise<any> {
  // Guardar en la base de datos
  await prisma.onboarding.upsert({
    where: { userId },
    update: {
      mainGoals: args.meta_financiera,
      mainChallenge: args.desafio_financiero,
      mainChallengeOther: args.desafio_financiero.toLowerCase().includes('otro') ? args.desafio_financiero : undefined,
      savingHabit: args.habito_ahorro,
      emergencyFund: args.fondo_emergencia,
      financialFeeling: args.sentir_financiero,
      incomeRange: args.rango_ingresos
    },
    create: {
      userId,
      mainGoals: args.meta_financiera,
      mainChallenge: args.desafio_financiero,
      mainChallengeOther: args.desafio_financiero.toLowerCase().includes('otro') ? args.desafio_financiero : undefined,
      savingHabit: args.habito_ahorro,
      emergencyFund: args.fondo_emergencia,
      financialFeeling: args.sentir_financiero,
      incomeRange: args.rango_ingresos
    },
  });

  await prisma.user.update({
    where: { id: userId },
    data: { onboarding: true, onboardingCompleted: true },
  });

  return {
    success: true,
    message: `¡Perfecto ${userName}! 🎉\n\nHa sido un placer conocerte y aprender sobre tus metas financieras. Ya tengo toda la información que necesito para ser tu copiloto financiero personal.\n\nTu perfil está listo y ahora puedes comenzar a usar todas las herramientas de FinZen AI. ¡Te veo en el dashboard! 😊`,
    onboardingCompleted: true
  };
}

// Función para ejecutar manage_transaction_record
async function executeManageTransactionRecord(args: any, userId: string, categories?: string[]): Promise<any> {
  let transactionData = args.transaction_data;
  const operation = args.operation;
  const module = args.module;
  let criterios = args.criterios_identificacion || {};

  // Procesar fechas en los datos de transacción
  if (transactionData) {
    transactionData = procesarFechasEnDatosTransaccion(transactionData);
  }

  // Procesar fechas en los criterios
  if (criterios && Object.keys(criterios).length > 0) {
    criterios = procesarFechasEnDatosTransaccion(criterios);
  }

  // Validaciones estructurales
  if (!['insert', 'update', 'delete', 'list'].includes(operation)) {
    throw new Error('Operación inválida: debe ser insert, update, delete o list');
  }

  if (module !== 'transacciones') {
    throw new Error('Solo se soporta el módulo "transacciones"');
  }

  // Validaciones por operación
  if (operation === 'insert') {
    const validation = validateTransactionData(transactionData);
    if (!validation.valid) {
      throw new Error(`Datos de transacción inválidos: ${validation.errors.join(', ')}`);
    }
  }

  if (operation === 'update' || operation === 'delete') {
    const criteriosValidation = validateCriterios(criterios);
    if (!criteriosValidation.valid) {
      throw new Error(`Criterios de identificación inválidos: ${criteriosValidation.errors.join(', ')}`);
    }
  }

  // Ejecutar operación
  switch (operation) {
    case 'insert':
      return await insertTransaction(transactionData, userId, categories);
    case 'update':
      return await updateTransaction(transactionData, criterios, userId, categories);
    case 'delete':
      return await deleteTransaction(criterios, userId, categories);
    case 'list':
      return await listTransactions(transactionData, userId, categories);
    default:
      throw new Error('Operación no soportada');
  }
}

// Función para ejecutar manage_budget_record
async function executeManageBudgetRecord(args: any, userId: string, categories?: string[]): Promise<any> {
  const { operation, module, category, amount, previous_amount, recurrence } = args;

  // Validaciones
  if (!['insert', 'update', 'delete', 'list'].includes(operation)) {
    throw new Error('Operación inválida: debe ser insert, update, delete o list');
  }

  if (module !== 'presupuestos') {
    throw new Error('Solo se soporta el módulo "presupuestos"');
  }

  if (!category) {
    throw new Error('La categoría es requerida');
  }

  if (!amount && operation !== 'list') {
    throw new Error('El monto es requerido');
  }

  if (recurrence && !['semanal', 'mensual', 'anual'].includes(recurrence)) {
    throw new Error('La recurrencia debe ser: semanal, mensual o anual');
  }

  // Ejecutar operación
  switch (operation) {
    case 'insert':
      return await insertBudget(category, amount, recurrence, userId, categories);
    case 'update':
      return await updateBudget(category, previous_amount, amount, userId, categories);
    case 'delete':
      return await deleteBudget(category, previous_amount, userId, categories);
    case 'list':
      return await listBudgets(category, userId, categories);
    default:
      throw new Error('Operación no soportada');
  }
}

// Función para ejecutar manage_goal_record
async function executeManageGoalRecord(args: any, userId: string, categories?: string[]): Promise<any> {
  const { operation, module, goal_data, criterios_identificacion } = args;

  // Validaciones
  if (!['insert', 'update', 'delete', 'list'].includes(operation)) {
    throw new Error('Operación inválida: debe ser insert, update, delete o list');
  }

  if (module !== 'metas') {
    throw new Error('Solo se soporta el módulo "metas"');
  }

  // Validaciones por operación
  if (operation === 'insert' || operation === 'update') {
    if (!goal_data) {
      throw new Error('Goal_data es requerido para insert y update');
    }
    const validation = validateGoalData(goal_data);
    if (!validation.valid) {
      throw new Error(`Datos de meta inválidos: ${validation.errors.join(', ')}`);
    }
  }

  if (operation === 'update' || operation === 'delete') {
    if (!criterios_identificacion) {
      throw new Error('Criterios_identificacion es requerido para update y delete');
    }
    const criteriosValidation = validateGoalCriterios(criterios_identificacion);
    if (!criteriosValidation.valid) {
      throw new Error(`Criterios de identificación inválidos: ${criteriosValidation.errors.join(', ')}`);
    }
  }

  // Ejecutar operación
  switch (operation) {
    case 'insert':
      return await insertGoal(goal_data, userId, categories);
    case 'update':
      return await updateGoal(goal_data, criterios_identificacion, userId, categories);
    case 'delete':
      return await deleteGoal(criterios_identificacion, userId, categories);
    case 'list':
      return await listGoals(goal_data, userId, categories);
    default:
      throw new Error('Operación no soportada');
  }
}

// Funciones auxiliares para transacciones
async function insertTransaction(transactionData: any, userId: string, categories?: string[]): Promise<any> {
  const type = transactionData.type === 'gasto' ? 'EXPENSE' : 'INCOME';
  const amount = parseFloat(transactionData.amount);
  const categoryName = transactionData.category;
  
  // Obtener fecha actual en zona horaria de República Dominicana
  const ahora = new Date();
  const offsetRD = -4; // UTC-4 para República Dominicana
  const utc = ahora.getTime() + (ahora.getTimezoneOffset() * 60000);
  const fechaRD = new Date(utc + (offsetRD * 60 * 60 * 1000));
  
  let date = fechaRD;
  if (transactionData.date) {
    // Si se proporciona una fecha, validar que sea razonable (no muy antigua)
    const fechaProporcionada = new Date(transactionData.date + 'T00:00:00');
    const fechaMinima = new Date('2020-01-01'); // Fecha mínima razonable
    
    if (fechaProporcionada < fechaMinima) {
      console.log(`[Zenio] Fecha proporcionada (${transactionData.date}) es muy antigua, usando fecha actual`);
      date = fechaRD;
    } else {
      date = fechaProporcionada;
    }
  }
  
  const description = transactionData.description || '';

  const categoryValidation = await validateCategory(categoryName, transactionData.type, categories);
  if (!categoryValidation.valid) {
    return {
      success: false,
      message: `🤔 **Categoría no encontrada**\n\nNo encontré la categoría "${categoryName}" en tu lista de categorías.\n\n**Categorías disponibles para transacciones:**\n${categoryValidation.suggestions?.map(cat => `• ${cat}`).join('\n')}\n\n¿Podrías elegir una de estas categorías o especificar una nueva?`,
      suggestions: categoryValidation.suggestions,
      action: 'category_not_found'
    };
  }

  const newTransaction = await prisma.transaction.create({
    data: {
      userId,
      amount,
      type,
      category_id: categoryValidation.categoryId!,
      description,
      date
    },
    select: {
      id: true,
      amount: true,
      type: true,
      category: true,
      description: true,
      date: true,
      createdAt: true,
      updatedAt: true
    }
  });

  const categoryRecord = await prisma.category.findUnique({
    where: { id: categoryValidation.categoryId! }
  });

  // Determinar si se usó fecha por defecto
  const fechaUsadaPorDefecto = !transactionData.date;
  const mensajeFecha = fechaUsadaPorDefecto 
    ? `📅 **Fecha:** ${date.toLocaleDateString('es-ES')} (fecha actual)`
    : `📅 **Fecha:** ${date.toLocaleDateString('es-ES')}`;

  return {
    success: true,
    message: `✅ **Transacción registrada exitosamente**\n\n💰 **Monto:** RD$${amount.toLocaleString('es-DO')}\n📊 **Tipo:** ${type === 'INCOME' ? 'Ingreso' : 'Gasto'}\n🏷️ **Categoría:** ${categoryRecord ? categoryRecord.name : categoryName}\n${mensajeFecha}\n\nLa transacción ha sido guardada en tu historial. ¡Puedes verla en la sección de Transacciones!`,
    transaction: newTransaction,
    action: 'transaction_created'
  };
}

async function updateTransaction(transactionData: any, criterios: any, userId: string, categories?: string[]): Promise<any> {
  let where: any = { userId };
  
  for (const [key, value] of Object.entries(criterios)) {
    if (key === 'amount' || key === 'oldAmount') where.amount = parseFloat(value as string);
    else if (key === 'type') where.type = value === 'gasto' ? 'EXPENSE' : 'INCOME';
    else if (key === 'category') {
      const cat = await prisma.category.findFirst({
        where: { name: { equals: value as string, mode: 'insensitive' } }
      });
      if (cat) {
        where.category = cat.id;
      } else {
        where.category = '___NO_MATCH___';
      }
    }
    else if (key === 'date') {
      const fechaNormalizada = normalizarFecha(value as string);
      if (fechaNormalizada) {
        const start = new Date(fechaNormalizada + 'T00:00:00.000Z');
        const end = new Date(start);
        end.setUTCDate(end.getUTCDate() + 1);
        where.date = { gte: start, lt: end };
      }
    }
    else if (key === 'description') where.description = { contains: value as string, mode: 'insensitive' };
    else if (key === 'id') where.id = value;
  }

  const candidates = await prisma.transaction.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, amount: true, type: true, category: true, description: true, date: true, createdAt: true, updatedAt: true
    }
  });

  if (candidates.length === 0) {
    throw new Error('No se encontró ninguna transacción con los criterios proporcionados');
  }

  if (candidates.length > 1) {
    throw new Error('Se encontraron varias transacciones. Por favor, proporciona más detalles para identificar la correcta');
  }

  const trans = candidates[0];
  const updateData: any = {};
  
  if (transactionData.amount) {
    const amount = parseFloat(transactionData.amount);
    if (isNaN(amount) || amount <= 0) {
      throw new Error('Amount debe ser un número positivo');
    }
    updateData.amount = amount;
  }
  
  if (transactionData.type) {
    if (!['gasto', 'ingreso'].includes(transactionData.type)) {
      throw new Error('Type debe ser "gasto" o "ingreso"');
    }
    updateData.type = transactionData.type === 'gasto' ? 'EXPENSE' : 'INCOME';
  }
  
  if (transactionData.category) {
    const categoryValidation = await validateCategory(transactionData.category, transactionData.type || 'gasto', categories);
    if (!categoryValidation.valid) {
      return {
        success: false,
        message: `🤔 **Categoría no encontrada**\n\nNo encontré la categoría "${transactionData.category}" en tu lista de categorías.\n\n**Categorías disponibles para transacciones:**\n${categoryValidation.suggestions?.map(cat => `• ${cat}`).join('\n')}\n\n¿Podrías elegir una de estas categorías o especificar una nueva?`,
        suggestions: categoryValidation.suggestions,
        action: 'category_not_found'
      };
    }
    updateData.category = categoryValidation.categoryId;
  }
  
  if (transactionData.date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(transactionData.date)) {
      throw new Error('Formato de fecha debe ser YYYY-MM-DD');
    }
    const dateObj = new Date(transactionData.date);
    if (isNaN(dateObj.getTime())) {
      throw new Error('Fecha inválida');
    }
    updateData.date = dateObj;
  }
  
  if (transactionData.description !== undefined) {
    updateData.description = transactionData.description;
  }

  const updated = await prisma.transaction.update({
    where: { id: trans.id },
    data: updateData,
    select: {
      id: true, amount: true, type: true, category: true, description: true, date: true, createdAt: true, updatedAt: true
    }
  });

  return {
    success: true,
    message: 'Transacción actualizada exitosamente',
    transaction: updated,
    action: 'transaction_updated'
  };
}

async function deleteTransaction(criterios: any, userId: string, categories?: string[]): Promise<any> {
  let where: any = { userId };
  
  for (const [key, value] of Object.entries(criterios)) {
    if (key === 'amount' || key === 'oldAmount') where.amount = parseFloat(value as string);
    else if (key === 'type') where.type = value === 'gasto' ? 'EXPENSE' : 'INCOME';
    else if (key === 'category') {
      const cat = await prisma.category.findFirst({
        where: { name: { equals: value as string, mode: 'insensitive' } }
      });
      if (cat) {
        where.category = cat.id;
      } else {
        where.category = '___NO_MATCH___';
      }
    }
    else if (key === 'date') {
      const fechaNormalizada = normalizarFecha(value as string);
      if (fechaNormalizada) {
        const start = new Date(fechaNormalizada + 'T00:00:00.000Z');
        const end = new Date(start);
        end.setUTCDate(end.getUTCDate() + 1);
        where.date = { gte: start, lt: end };
      }
    }
    else if (key === 'description') where.description = { contains: value as string, mode: 'insensitive' };
    else if (key === 'id') where.id = value;
  }

  const candidates = await prisma.transaction.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, amount: true, type: true, category: true, description: true, date: true, createdAt: true, updatedAt: true
    }
  });

  if (candidates.length === 0) {
    throw new Error('No se encontró ninguna transacción con los criterios proporcionados');
  }

  if (candidates.length > 1) {
    throw new Error('Se encontraron varias transacciones. Por favor, proporciona más detalles para identificar la correcta');
  }

  const trans = candidates[0];
  await prisma.transaction.delete({ where: { id: trans.id } });

  return {
    success: true,
    message: 'Transacción eliminada exitosamente',
    transaction: trans,
    action: 'transaction_deleted'
  };
}

async function listTransactions(transactionData: any, userId: string, categories?: string[]): Promise<any> {
  let where: any = { userId };
  
  if (transactionData) {
    if (transactionData.amount) {
      const amount = parseFloat(transactionData.amount);
      if (isNaN(amount) || amount <= 0) {
      throw new Error('Amount debe ser un número positivo');
      }
      where.amount = amount;
    }
    
    if (transactionData.type) {
      if (!['gasto', 'ingreso'].includes(transactionData.type)) {
      throw new Error('Type debe ser "gasto" o "ingreso"');
      }
      where.type = transactionData.type === 'gasto' ? 'EXPENSE' : 'INCOME';
    }
    
    if (transactionData.category) {
      const cat = await prisma.category.findFirst({
        where: { name: { equals: transactionData.category, mode: 'insensitive' } }
      });
      if (cat) {
        where.category_id = cat.id;
      }
    }
    
    if (transactionData.date) {
      const fechaNormalizada = normalizarFecha(transactionData.date);
      if (fechaNormalizada) {
        const start = new Date(fechaNormalizada + 'T00:00:00.000Z');
        const end = new Date(start);
        end.setUTCDate(end.getUTCDate() + 1);
        where.date = { gte: start, lt: end };
      }
    }
  }

  const transactions = await prisma.transaction.findMany({
    where,
    orderBy: { date: 'desc' },
    include: {
      category: {
        select: {
          id: true,
          name: true,
          icon: true,
          type: true,
          isDefault: true
        }
      }
    }
  });

  return {
    success: true,
    message: `Se encontraron ${transactions.length} transacciones`,
    transactions,
    action: 'transaction_list'
  };
}

// Funciones auxiliares para presupuestos
async function insertBudget(category: string, amount: string, recurrence: string, userId: string, categories?: string[]): Promise<any> {
  const periodMap: { [key: string]: string } = {
    'semanal': 'weekly',
    'mensual': 'monthly',
    'anual': 'yearly'
  };
  const period = periodMap[recurrence] || 'monthly';

  const now = new Date();
  let startDate: Date, endDate: Date;
  
  if (recurrence === 'semanal') {
    const day = now.getDay();
    const diffToMonday = (day === 0 ? -6 : 1) - day;
    startDate = new Date(now);
    startDate.setDate(now.getDate() + diffToMonday);
    startDate.setHours(0, 0, 0, 0);
    endDate = new Date(startDate);
    endDate.setDate(startDate.getDate() + 6);
    endDate.setHours(23, 59, 59, 999);
  } else if (recurrence === 'mensual') {
    startDate = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
  } else if (recurrence === 'anual') {
    startDate = new Date(now.getFullYear(), 0, 1, 0, 0, 0, 0);
    endDate = new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999);
  } else {
    startDate = now;
    endDate = now;
  }

  const categoryValidation = await validateCategory(category, 'gasto', categories);
  if (!categoryValidation.valid) {
    return {
      success: false,
      message: `🤔 **Categoría no encontrada**\n\nNo encontré la categoría "${category}" en tu lista de categorías.\n\n**Categorías disponibles para presupuestos:**\n${categoryValidation.suggestions?.map(cat => `• ${cat}`).join('\n')}\n\n¿Podrías elegir una de estas categorías o especificar una nueva?`,
      suggestions: categoryValidation.suggestions,
      action: 'category_not_found'
    };
  }

  const newBudget = await prisma.budget.create({
    data: {
      user_id: userId,
      name: category,
      category_id: categoryValidation.categoryId!,
      amount: parseFloat(amount),
      period,
      start_date: startDate,
      end_date: endDate,
      alert_percentage: 80
    },
    include: {
      category: {
        select: {
          id: true,
          name: true,
          icon: true,
          type: true,
          isDefault: true
        }
      }
    }
  });

  const categoryRecord = await prisma.category.findUnique({
    where: { id: categoryValidation.categoryId! }
  });

  return {
    success: true,
    message: `✅ **Presupuesto creado exitosamente**\n\n📋 **Categoría:** ${categoryRecord ? categoryRecord.name : category}\n💰 **Monto:** RD$${parseFloat(amount).toLocaleString('es-DO')}\n📅 **Período:** ${recurrence === 'mensual' ? 'Mensual' : recurrence === 'semanal' ? 'Semanal' : 'Anual'}\n📆 **Desde:** ${startDate.toLocaleDateString('es-ES')}\n📆 **Hasta:** ${endDate.toLocaleDateString('es-ES')}\n\nEl presupuesto ha sido guardado. ¡Puedes verlo en la sección de Presupuestos!`,
    budget: newBudget,
    action: 'budget_created'
  };
}

async function updateBudget(category: string, previous_amount: string, amount: string, userId: string, categories?: string[]): Promise<any> {
  const where: any = { 
    user_id: userId,
    amount: parseFloat(previous_amount)
  };

  const cat = await prisma.category.findFirst({
    where: { name: { equals: category, mode: 'insensitive' } }
  });
  
  if (cat) {
    where.category_id = cat.id;
  } else {
    // Sugerencias conversacionales
    const categoryValidation = await validateCategory(category, 'gasto', categories);
    return {
      success: false,
      message: `🤔 **Categoría no encontrada**\n\nNo encontré la categoría "${category}" en tu lista de categorías.\n\n**Categorías disponibles para presupuestos:**\n${categoryValidation.suggestions?.map(cat => `• ${cat}`).join('\n')}\n\n¿Podrías elegir una de estas categorías o especificar una nueva?`,
      suggestions: categoryValidation.suggestions,
      action: 'category_not_found'
    };
  }

  const budget = await prisma.budget.findFirst({
    where,
    orderBy: { created_at: 'desc' },
    include: {
      category: {
        select: {
          id: true,
          name: true,
          icon: true,
          type: true,
          isDefault: true
        }
      }
    }
  });

  if (!budget) {
    throw new Error(`No encontré un presupuesto de ${category} con monto ${previous_amount}`);
  }

  const updated = await prisma.budget.update({
    where: { id: budget.id },
    data: { amount: parseFloat(amount) },
    include: {
      category: {
        select: {
          id: true,
          name: true,
          icon: true,
          type: true,
          isDefault: true
        }
      }
    }
  });
  
  return {
    success: true,
    message: `Presupuesto de ${category} actualizado de RD$${previous_amount} a RD$${amount}`,
    budget: updated,
    action: 'budget_updated'
  };
}

async function deleteBudget(category: string, previous_amount: string, userId: string, categories?: string[]): Promise<any> {
  const where: any = { 
    user_id: userId,
    amount: parseFloat(previous_amount)
  };

  const cat = await prisma.category.findFirst({
    where: { name: { equals: category, mode: 'insensitive' } }
  });
  
  if (cat) {
    where.category_id = cat.id;
  } else {
    throw new Error(`No encontré la categoría "${category}"`);
  }

  const budget = await prisma.budget.findFirst({
    where,
    orderBy: { created_at: 'desc' },
    include: {
      category: {
        select: {
          id: true,
          name: true,
          icon: true,
          type: true,
          isDefault: true
        }
      }
    }
  });

  if (!budget) {
    throw new Error(`No encontré un presupuesto de ${category} con monto ${previous_amount}`);
  }
  
  await prisma.budget.delete({ where: { id: budget.id } });
  
  return {
    success: true,
    message: `Presupuesto de ${category} eliminado exitosamente`,
    budget: budget,
    action: 'budget_deleted'
  };
}

async function listBudgets(category: string | undefined, userId: string, categories?: string[]): Promise<any> {
  let where: any = { user_id: userId };
  
  if (category) {
    const cat = await prisma.category.findFirst({
      where: { name: { equals: category, mode: 'insensitive' } }
    });
    if (cat) {
      where.category_id = cat.id;
    }
  }

  const budgetList = await prisma.budget.findMany({
    where,
    orderBy: { created_at: 'desc' },
    include: {
      category: {
        select: {
          id: true,
          name: true,
          icon: true,
          type: true,
          isDefault: true
        }
      }
    }
  });
  
  return {
    success: true,
    message: category 
      ? `Se encontraron ${budgetList.length} presupuestos para ${category}`
      : `Se encontraron ${budgetList.length} presupuestos en total`,
    budgets: budgetList,
    action: 'budget_list'
  };
}

// Funciones auxiliares para metas
async function insertGoal(goalData: any, userId: string, categories?: string[]): Promise<any> {
  const {
    name,
    target_amount,
    category,
    monthly_type,
    monthly_value,
    due_date,
    priority,
    description
  } = goalData;

  // Validar categoría
  const categoryValidation = await validateCategory(category, 'gasto', categories);
  if (!categoryValidation.valid) {
    // En vez de lanzar error, responder de forma conversacional
    return {
      success: false,
      message: `🤔 **Categoría no encontrada**\n\nNo encontré la categoría "${category}" en tu lista de categorías.\n\n**Categorías disponibles para metas:**\n${categoryValidation.suggestions?.map(cat => `• ${cat}`).join('\n')}\n\n¿Podrías elegir una de estas categorías o especificar una nueva?`,
      suggestions: categoryValidation.suggestions,
      action: 'category_not_found'
    };
  }

  const newGoal = await prisma.goal.create({
    data: {
      userId,
      name,
      targetAmount: parseFloat(target_amount),
      currentAmount: 0,
      categoryId: categoryValidation.categoryId!,
      monthlyTargetPercentage: monthly_type === 'porcentaje' ? parseFloat(monthly_value) : null,
      monthlyContributionAmount: monthly_type === 'fijo' ? parseFloat(monthly_value) : null,
      targetDate: due_date ? new Date(due_date) : null,
      priority: priority || 'Media',
      description: description || '',
      isCompleted: false,
      isActive: true,
      contributionsCount: 0
    },
    include: {
      category: {
        select: {
          id: true,
          name: true,
          icon: true,
          type: true
        }
      }
    }
  });

  const categoryRecord = await prisma.category.findUnique({
    where: { id: categoryValidation.categoryId! }
  });

  const mensajeFecha = due_date 
    ? `📅 **Fecha objetivo:** ${new Date(due_date).toLocaleDateString('es-ES')}`
    : '📅 **Fecha objetivo:** Sin fecha límite';

  const mensajeMensual = monthly_type === 'porcentaje' 
    ? `📊 **Objetivo mensual:** ${monthly_value}% de tus ingresos`
    : monthly_type === 'fijo'
    ? `📊 **Objetivo mensual:** RD$${parseFloat(monthly_value).toLocaleString('es-DO')} fijos`
    : '📊 **Objetivo mensual:** No definido';

  return {
    success: true,
    message: `✅ **Meta creada exitosamente**\n\n🎯 **Meta:** ${name}\n💰 **Monto objetivo:** RD$${parseFloat(target_amount).toLocaleString('es-DO')}\n🏷️ **Categoría:** ${categoryRecord ? categoryRecord.name : category}\n${mensajeFecha}\n${mensajeMensual}\n📈 **Prioridad:** ${priority || 'Media'}\n\nLa meta ha sido guardada. ¡Puedes verla en la sección de Metas!`,
    goal: newGoal,
    action: 'goal_created'
  };
}

async function updateGoal(goalData: any, criterios: any, userId: string, categories?: string[]): Promise<any> {
  let where: any = { userId };
  
  // Construir criterios de búsqueda
  for (const [key, value] of Object.entries(criterios)) {
    if (key === 'name') where.name = { contains: value as string, mode: 'insensitive' };
    else if (key === 'target_amount') where.targetAmount = parseFloat(value as string);
    else if (key === 'due_date') {
      const fechaNormalizada = normalizarFecha(value as string);
      if (fechaNormalizada) {
        const start = new Date(fechaNormalizada + 'T00:00:00.000Z');
        const end = new Date(start);
        end.setUTCDate(end.getUTCDate() + 1);
        where.targetDate = { gte: start, lt: end };
      }
    }
    else if (key === 'category') {
      const cat = await prisma.category.findFirst({
        where: { name: { equals: value as string, mode: 'insensitive' } }
      });
      if (cat) {
        where.categoryId = cat.id;
      } else {
        where.categoryId = '___NO_MATCH___';
      }
    }
  }

  const candidates = await prisma.goal.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: {
      category: {
        select: {
          id: true,
          name: true,
          icon: true,
          type: true
        }
      }
    }
  });

  if (candidates.length === 0) {
    throw new Error('No se encontró ninguna meta con los criterios proporcionados');
  }

  if (candidates.length > 1) {
    throw new Error('Se encontraron varias metas. Por favor, proporciona más detalles para identificar la correcta');
  }

  const goal = candidates[0];
  const updateData: any = {};
  
  if (goalData.name) updateData.name = goalData.name;
  if (goalData.target_amount) {
    const amount = parseFloat(goalData.target_amount);
    if (isNaN(amount) || amount <= 0) {
      throw new Error('Target_amount debe ser un número positivo');
    }
    updateData.targetAmount = amount;
  }
  if (goalData.category) {
    const categoryValidation = await validateCategory(goalData.category, 'gasto', categories);
    if (!categoryValidation.valid) {
      throw new Error(categoryValidation.error || 'Categoría inválida');
    }
    updateData.categoryId = categoryValidation.categoryId;
  }
  if (goalData.monthly_type) {
    if (goalData.monthly_type === 'porcentaje') {
      updateData.monthlyTargetPercentage = goalData.monthly_value ? parseFloat(goalData.monthly_value) : null;
      updateData.monthlyContributionAmount = null;
    } else if (goalData.monthly_type === 'fijo') {
      updateData.monthlyContributionAmount = goalData.monthly_value ? parseFloat(goalData.monthly_value) : null;
      updateData.monthlyTargetPercentage = null;
    }
  }
  if (goalData.due_date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(goalData.due_date)) {
      throw new Error('Formato de fecha debe ser YYYY-MM-DD');
    }
    const dateObj = new Date(goalData.due_date);
    if (isNaN(dateObj.getTime())) {
      throw new Error('Fecha inválida');
    }
    updateData.targetDate = dateObj;
  }
  if (goalData.priority) updateData.priority = goalData.priority;
  if (goalData.description !== undefined) updateData.description = goalData.description;

  const updated = await prisma.goal.update({
    where: { id: goal.id },
    data: updateData,
    include: {
      category: {
        select: {
          id: true,
          name: true,
          icon: true,
          type: true
        }
      }
    }
  });

  return {
    success: true,
    message: `✅ **Meta actualizada exitosamente**\n\n🎯 **Meta:** ${updated.name}\n💰 **Monto objetivo:** RD$${updated.targetAmount.toLocaleString('es-DO')}\n🏷️ **Categoría:** ${updated.category.name}\n📈 **Prioridad:** ${updated.priority}\n\nLos cambios han sido guardados. ¡Puedes ver la meta actualizada en la sección de Metas!`,
    goal: updated,
    action: 'goal_updated'
  };
}

async function deleteGoal(criterios: any, userId: string, categories?: string[]): Promise<any> {
  let where: any = { userId };
  
  // Construir criterios de búsqueda
  for (const [key, value] of Object.entries(criterios)) {
    if (key === 'name') where.name = { contains: value as string, mode: 'insensitive' };
    else if (key === 'target_amount') where.targetAmount = parseFloat(value as string);
    else if (key === 'due_date') {
      const fechaNormalizada = normalizarFecha(value as string);
      if (fechaNormalizada) {
        const start = new Date(fechaNormalizada + 'T00:00:00.000Z');
        const end = new Date(start);
        end.setUTCDate(end.getUTCDate() + 1);
        where.targetDate = { gte: start, lt: end };
      }
    }
    else if (key === 'category') {
      const cat = await prisma.category.findFirst({
        where: { name: { equals: value as string, mode: 'insensitive' } }
      });
      if (cat) {
        where.categoryId = cat.id;
      } else {
        where.categoryId = '___NO_MATCH___';
      }
    }
  }

  const candidates = await prisma.goal.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: {
      category: {
        select: {
          id: true,
          name: true,
          icon: true,
          type: true
        }
      }
    }
  });

  if (candidates.length === 0) {
    throw new Error('No se encontró ninguna meta con los criterios proporcionados');
  }

  if (candidates.length > 1) {
    throw new Error('Se encontraron varias metas. Por favor, proporciona más detalles para identificar la correcta');
  }

  const goal = candidates[0];
  
  await prisma.goal.delete({ where: { id: goal.id } });
  
  return {
    success: true,
    message: `✅ **Meta eliminada exitosamente**\n\n🎯 **Meta:** ${goal.name}\n💰 **Monto objetivo:** RD$${goal.targetAmount.toLocaleString('es-DO')}\n🏷️ **Categoría:** ${goal.category.name}\n\nLa meta ha sido eliminada de tu lista.`,
    goal: goal,
    action: 'goal_deleted'
  };
}

async function listGoals(goalData: any, userId: string, categories?: string[]): Promise<any> {
  let where: any = { userId };
  
  // Si se proporciona categoría específica
  if (goalData && goalData.category) {
    const cat = await prisma.category.findFirst({
      where: { name: { equals: goalData.category, mode: 'insensitive' } }
    });
    if (cat) {
      where.categoryId = cat.id;
    }
  }

  const goalList = await prisma.goal.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: {
      category: {
        select: {
          id: true,
          name: true,
          icon: true,
          type: true
        }
      }
    }
  });
  
  return {
    success: true,
    message: goalData && goalData.category 
      ? `Se encontraron ${goalList.length} metas para ${goalData.category}`
      : `Se encontraron ${goalList.length} metas en total`,
    goals: goalList,
    action: 'goal_list'
  };
}

export const chatWithZenio = async (req: Request, res: Response) => {
  let threadId: string | undefined = undefined;
  
  try {
    // 1. Validar usuario autenticado
    const userId = req.user?.id;
    if (!userId) {
      throw new Error('No se pudo determinar el usuario autenticado.');
    }

    // 2. Obtener información del usuario
    let userName = 'Usuario';
    let user = null;
    try {
      user = await prisma.user.findUnique({ where: { id: userId } });
      userName = user?.name || user?.email || 'Usuario';
    } catch (e) {
      console.error('No se pudo obtener el nombre del usuario:', e);
    }

    // 3. Obtener datos de la petición
    let { message, threadId: incomingThreadId, isOnboarding, categories } = req.body;
    threadId = incomingThreadId;

    // 4. Procesar expresiones temporales
    if (typeof message === 'string') {
      const mensajeOriginal = message;
      message = reemplazarExpresionesTemporalesPorFecha(message);
      if (mensajeOriginal !== message) {
        const ahora = new Date();
        const offsetRD = -4;
        const utc = ahora.getTime() + (ahora.getTimezoneOffset() * 60000);
        const fechaRD = new Date(utc + (offsetRD * 60 * 60 * 1000));
        
        console.log('🕐 Fechas relativas reemplazadas:');
        console.log('   Zona horaria: República Dominicana (UTC-4)');
        console.log('   Fecha local actual:', fechaRD.toISOString().split('T')[0]);
        console.log('   Original:', mensajeOriginal);
        console.log('   Procesado:', message);
      }
    }

    // 5. Crear o reutilizar thread
    let isFirstMessage = !threadId || typeof threadId !== 'string' || !threadId.startsWith('thread_');

    if (isFirstMessage) {
      // Crear thread vacío
      const threadRes = await axios.post(
        `${OPENAI_BASE_URL}/threads`,
        {},
        { headers: { ...OPENAI_HEADERS, 'Content-Type': 'application/json' } }
      );
      threadId = threadRes.data.id;
      
      // Mensaje de sistema para que Zenio sepa el nombre del usuario
      const systemMsg = `El usuario se llama ${userName}. Siempre que lo saludes, hazlo de forma natural y menciona su nombre en el saludo, tanto al inicio como en cualquier otro saludo durante la conversación.`;
      await axios.post(
        `${OPENAI_BASE_URL}/threads/${threadId}/messages`,
        {
          role: "user",
          content: systemMsg
        },
        { headers: { ...OPENAI_HEADERS, 'Content-Type': 'application/json' } }
      );

      // Agregar mensaje de onboarding si es necesario
      if (isOnboarding && !user?.onboardingCompleted) {
        const onboardingMsg = `Quiero iniciar mi onboarding financiero. Mi nombre es ${userName}.`;
        await axios.post(
          `${OPENAI_BASE_URL}/threads/${threadId}/messages`,
          {
            role: "user",
            content: onboardingMsg
          },
          { headers: { ...OPENAI_HEADERS, 'Content-Type': 'application/json' } }
        );
      } else if (message) {
        // Agregar mensaje del usuario
        await axios.post(
          `${OPENAI_BASE_URL}/threads/${threadId}/messages`,
          {
            role: "user",
            content: message
          },
          { headers: { ...OPENAI_HEADERS, 'Content-Type': 'application/json' } }
        );
      }
    } else {
      // Agregar mensaje del usuario al thread existente
      await axios.post(
        `${OPENAI_BASE_URL}/threads/${threadId}/messages`,
        {
          role: "user",
          content: message
        },
        { headers: { ...OPENAI_HEADERS, 'Content-Type': 'application/json' } }
      );
    }

    // 6. Crear run con el assistant
    console.log('[Zenio] Creando run...');
    const runRes = await axios.post(
      `${OPENAI_BASE_URL}/threads/${threadId}/runs`,
      {
        assistant_id: ASSISTANT_ID
      },
      { headers: { ...OPENAI_HEADERS, 'Content-Type': 'application/json' } }
    );

    const runId = runRes.data.id;
    console.log(`[Zenio] Run creado: ${runId}`);

    // 7. Hacer polling del run
    console.log('[Zenio] Iniciando polling del run...');
    const run = await pollRunStatus(threadId!, runId);

    // 8. Manejar tool calls si los hay
    let executedActions: any[] = [];
    if (run.status === 'requires_action' && run.required_action?.submit_tool_outputs?.tool_calls) {
      console.log('[Zenio] Tool calls detectados, ejecutando...');
      const toolCallResult = await executeToolCalls(
        threadId!, 
        runId, 
        run.required_action.submit_tool_outputs.tool_calls,
        userId,
        userName,
        categories // Pasar las categorías disponibles
      );

      // Extraer las acciones ejecutadas
      if (toolCallResult.executedActions) {
        executedActions = toolCallResult.executedActions;
      }

      // Si después de ejecutar tool calls el run aún requiere acción, hacer polling nuevamente
      if (toolCallResult.run.status === 'requires_action') {
        console.log('[Zenio] Run aún requiere acción después de tool calls, continuando polling...');
        await pollRunStatus(threadId!, runId);
      }
    }

    // 9. Obtener la respuesta final del assistant
    console.log('[Zenio] Obteniendo respuesta final...');
    const messagesRes = await axios.get(
      `${OPENAI_BASE_URL}/threads/${threadId}/messages`,
      { headers: OPENAI_HEADERS }
    );
    
    const messages = messagesRes.data.data;
    const lastAssistantMessage = messages.find((msg: any) => msg.role === 'assistant');
    const assistantResponse = lastAssistantMessage?.content?.[0]?.text?.value || 'No se pudo obtener respuesta del asistente.';

    // 10. Responder al frontend
    console.log('[Zenio] Enviando respuesta al frontend');
    
    // Preparar respuesta con acciones ejecutadas
    const response: any = {
      message: assistantResponse,
      threadId
    };

    // Incluir la última acción ejecutada para el frontend
    if (executedActions.length > 0) {
      const lastAction = executedActions[executedActions.length - 1];
      response.action = lastAction.action;
      response.transaction = lastAction.data.transaction;
      response.budget = lastAction.data.budget;
      response.goal = lastAction.data.goal; // Incluir la meta si es una acción de meta
      console.log(`[Zenio] Incluyendo acción en respuesta: ${lastAction.action}`);
    }

    return res.json(response);

  } catch (error) {
    console.error('[Zenio] Error:', error);

    // Manejo específico de errores
    if (axios.isAxiosError(error)) {
      if (error.code === 'ECONNRESET') {
        return res.status(503).json({
          message: 'No se pudo conectar con Zenio (OpenAI). Por favor, intenta de nuevo en unos segundos.',
          threadId
        });
      }

      if (error.response?.status === 429) {
        return res.status(429).json({
          message: 'Zenio está procesando muchos mensajes. Por favor, espera un momento antes de continuar.',
          threadId
        });
      }

      if (error.response?.data?.error?.message?.includes('while a run')) {
        return res.status(429).json({
          message: 'Zenio está terminando de procesar tu mensaje anterior. Por favor, espera un momento antes de continuar.',
          threadId
        });
      }

      if (error.response) {
        console.error('❌ OpenAI API error:', error.response.data);
        return res.status(500).json({ 
          error: 'Error al comunicarse con Zenio.', 
          openai: error.response.data 
        });
      }
    }

    // Error general
    console.error('❌ Error general:', error);
    return res.status(500).json({ 
      error: 'Error al comunicarse con Zenio.',
      message: error instanceof Error ? error.message : 'Error desconocido'
    });
  }
};

export const getChatHistory = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { threadId } = req.query;

    if (!threadId) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'Thread ID is required'
      });
    }

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({
        error: 'Configuration error',
        message: 'OpenAI configuration is missing'
      });
    }

    // Aquí puedes implementar la recuperación del historial usando axios y los endpoints v2 si lo necesitas
    return res.status(501).json({ error: 'Not implemented' });
  } catch (error) {
    return res.status(500).json({ error: 'Error al recuperar el historial.' });
  }
}; 

export const createTransactionFromZenio = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      throw new Error('No se pudo determinar el usuario autenticado.');
    }

    const { transaction_data, operation } = req.body;

    if (operation !== 'insert') {
      return res.status(400).json({
        error: 'Invalid operation',
        message: 'Only insert operation is supported'
      });
    }

    // Validar y mapear los datos
    const type = transaction_data.type === 'gasto' ? 'EXPENSE' : 'INCOME';
    const amount = parseFloat(transaction_data.amount);
    const category = transaction_data.category;
    const date = transaction_data.date ? new Date(transaction_data.date) : new Date();
    const description = transaction_data.description || '';

    // Validaciones básicas
    if (!amount || amount <= 0) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'El monto debe ser un número positivo'
      });
    }

    if (!category) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'La categoría es requerida'
      });
    }

    // Crear la transacción
    const newTransaction = await prisma.transaction.create({
      data: {
        userId,
        amount,
        type,
        category_id: category,
        description,
        date
      },
      select: {
        id: true,
        amount: true,
        type: true,
        category: true,
        description: true,
        date: true,
        createdAt: true,
        updatedAt: true
      }
    });

    // Mensaje de confirmación
    const confirmationMessage = `✅ **Transacción registrada exitosamente**\n\n💰 **Monto:** RD$${amount.toLocaleString('es-DO')}\n📊 **Tipo:** ${type === 'INCOME' ? 'Ingreso' : 'Gasto'}\n🏷️ **Categoría:** ${category}\n📅 **Fecha:** ${date.toLocaleDateString('es-ES')}\n\nLa transacción ha sido guardada en tu historial. ¡Puedes verla en la sección de Transacciones!`;

    return res.json({
      message: confirmationMessage,
      transaction: newTransaction,
      action: 'transaction_created'
    });

  } catch (error) {
    console.error('Error creating transaction from Zenio:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: 'Error al crear la transacción'
    });
  }
};

export const createBudgetFromZenio = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      throw new Error('No se pudo determinar el usuario autenticado.');
    }

    const { budget_data, operation } = req.body;

    if (operation !== 'insert') {
      return res.status(400).json({
        error: 'Invalid operation',
        message: 'Only insert operation is supported'
      });
    }

    // Validar datos del presupuesto
    const validation = validateBudgetData(budget_data);
    if (!validation.valid) {
      return res.status(400).json({ 
        error: 'Datos de presupuesto inválidos', 
        details: validation.errors 
      });
    }

    // Validar y mapear los datos
    const name = budget_data.name;
    const amount = parseFloat(budget_data.amount);
    const categoryName = budget_data.category;
    const period = budget_data.period;
    const startDate = new Date(budget_data.start_date);
    const endDate = new Date(budget_data.end_date);
    const alertPercentage = budget_data.alert_percentage || 80;

    // Validar categoría contra la base de datos
    const categoryValidation = await validateCategory(categoryName, 'gasto');
    if (!categoryValidation.valid) {
      return res.status(400).json({ 
        error: 'Categoría inválida', 
        message: categoryValidation.error 
      });
    }

    const categoryId = categoryValidation.categoryId!;

    // Crear el presupuesto
    const newBudget = await prisma.budget.create({
      data: {
        user_id: userId,
        name,
        category_id: categoryId,
        amount,
        period,
        start_date: startDate,
        end_date: endDate,
        alert_percentage: alertPercentage
      },
      include: {
        category: {
          select: {
            id: true,
            name: true,
            icon: true,
            type: true,
            isDefault: true
          }
        }
      }
    });

    // Obtener el nombre de la categoría para el mensaje
    const categoryRecord = await prisma.category.findUnique({
      where: { id: categoryId }
    });
    
    // Mensaje de confirmación
    const confirmationMessage = `✅ **Presupuesto creado exitosamente**\n\n📋 **Nombre:** ${name}\n💰 **Monto:** RD$${amount.toLocaleString('es-DO')}\n🏷️ **Categoría:** ${categoryRecord ? categoryRecord.name : categoryName}\n📅 **Período:** ${period === 'monthly' ? 'Mensual' : period === 'weekly' ? 'Semanal' : 'Anual'}\n📆 **Desde:** ${startDate.toLocaleDateString('es-ES')}\n📆 **Hasta:** ${endDate.toLocaleDateString('es-ES')}\n\nEl presupuesto ha sido guardado. ¡Puedes verlo en la sección de Presupuestos!`;

    return res.json({
      message: confirmationMessage,
      budget: newBudget,
      action: 'budget_created'
    });

  } catch (error) {
    console.error('Error creating budget from Zenio:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: 'Error al crear el presupuesto'
    });
  }
}; 

export const createGoalFromZenio = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      throw new Error('No se pudo determinar el usuario autenticado.');
    }

    const { goal_data, operation } = req.body;

    if (operation !== 'insert') {
      return res.status(400).json({
        error: 'Invalid operation',
        message: 'Only insert operation is supported'
      });
    }

    // Validar datos de la meta
    const validation = validateGoalData(goal_data);
    if (!validation.valid) {
      return res.status(400).json({ 
        error: 'Datos de meta inválidos', 
        details: validation.errors 
      });
    }

    // Validar y mapear los datos
    const name = goal_data.name;
    const target_amount = parseFloat(goal_data.target_amount);
    const categoryName = goal_data.category;
    const monthly_type = goal_data.monthly_type;
    const monthly_value = goal_data.monthly_value;
    const due_date = goal_data.due_date;
    const priority = goal_data.priority;
    const description = goal_data.description || '';

    // Validar categoría contra la base de datos
    const categoryValidation = await validateCategory(categoryName, 'gasto');
    if (!categoryValidation.valid) {
      return res.status(400).json({ 
        error: 'Categoría inválida', 
        message: categoryValidation.error 
      });
    }

    const categoryId = categoryValidation.categoryId!;

    // Crear la meta
    const newGoal = await prisma.goal.create({
      data: {
        userId,
        name,
        targetAmount: target_amount,
        currentAmount: 0,
        categoryId,
        monthlyTargetPercentage: monthly_type === 'porcentaje' ? parseFloat(monthly_value) : null,
        monthlyContributionAmount: monthly_type === 'fijo' ? parseFloat(monthly_value) : null,
        targetDate: due_date ? new Date(due_date) : null,
        priority: priority || 'Media',
        description: description,
        isCompleted: false,
        isActive: true,
        contributionsCount: 0
      },
      include: {
        category: {
          select: {
            id: true,
            name: true,
            icon: true,
            type: true
          }
        }
      }
    });

    // Obtener el nombre de la categoría para el mensaje
    const categoryRecord = await prisma.category.findUnique({
      where: { id: categoryId }
    });
    
    // Mensaje de confirmación
    const confirmationMessage = `✅ **Meta creada exitosamente**\n\n🎯 **Meta:** ${name}\n💰 **Monto objetivo:** RD$${target_amount.toLocaleString('es-DO')}\n🏷️ **Categoría:** ${categoryRecord ? categoryRecord.name : categoryName}\n📅 **Período:** ${monthly_type === 'porcentaje' ? `${monthly_value}% de tus ingresos` : monthly_type === 'fijo' ? `RD$${parseFloat(monthly_value).toLocaleString('es-DO')} fijos` : 'No definido'}\n📅 **Fecha objetivo:** ${due_date ? new Date(due_date).toLocaleDateString('es-ES') : 'Sin fecha límite'}\n📈 **Prioridad:** ${priority || 'Media'}\n\nLa meta ha sido guardada. ¡Puedes verla en la sección de Metas!`;

    return res.json({
      message: confirmationMessage,
      goal: newGoal,
      action: 'goal_created'
    });

  } catch (error) {
    console.error('Error creating goal from Zenio:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: 'Error al crear la meta'
    });
  }
}; 