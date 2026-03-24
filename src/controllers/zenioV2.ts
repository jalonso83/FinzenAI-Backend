/**
 * Zenio V2 Controller - Responses API de OpenAI
 *
 * Reemplaza el flujo de Assistants API (threads/runs/polling) por una sola llamada
 * a openai.responses.create() con previous_response_id para estado de conversación.
 *
 * Reutiliza TODA la lógica de negocio del controlador original (zenio.ts).
 * Mantiene el mismo contrato API con las apps móviles (threadId en respuesta).
 */

import { Request, Response } from 'express';
import OpenAI from 'openai';
import { prisma } from '../lib/prisma';
import { ENV } from '../config/env';
import { logger } from '../utils/logger';
import { ZENIO_SYSTEM_PROMPT, ZENIO_MODEL, ZENIO_TEMPERATURE, ZENIO_VECTOR_STORE_ID } from '../config/zenioPrompt';
import { ZENIO_FUNCTION_TOOLS } from '../config/zenioTools';

// Importar lógica de negocio reutilizable del controlador original
import { MappingSource } from '@prisma/client';
import { merchantMappingService } from '../services/merchantMappingService';
import { NotificationService } from '../services/notificationService';
import { recalculateBudgetSpent } from './transactions';
import fs from 'fs';
import FormData from 'form-data';
import axios from 'axios';

// =============================================
// Cliente OpenAI para Responses API (sin header assistants)
// =============================================
const openai = new OpenAI({
  apiKey: ENV.OPENAI_API_KEY,
  timeout: 60000, // 60 segundos timeout
});

// =============================================
// UTILIDADES (copiadas del controlador original)
// =============================================

function formatearFechaYYYYMMDD(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function obtenerOffsetDeTimezone(timezone: string): number {
  const timezoneOffsets: { [key: string]: number } = {
    'America/Santo_Domingo': -4, 'America/Caracas': -4, 'America/New_York': -5,
    'America/Chicago': -6, 'America/Denver': -7, 'America/Los_Angeles': -8,
    'America/Anchorage': -9, 'Pacific/Honolulu': -10, 'Europe/London': 0,
    'Europe/Paris': 1, 'Europe/Berlin': 1, 'Europe/Madrid': 1, 'Europe/Rome': 1,
    'Europe/Moscow': 3, 'Asia/Dubai': 4, 'Asia/Tokyo': 9, 'Asia/Shanghai': 8,
    'Asia/Seoul': 9, 'Australia/Sydney': 10, 'Pacific/Auckland': 12, 'UTC': 0,
  };
  return timezoneOffsets[timezone] || 0;
}

function procesarFechaConZonaHoraria(fecha: string, timezone: string = 'UTC'): Date {
  if (timezone === 'UTC') {
    return new Date(fecha + 'T00:00:00Z');
  }
  const offset = obtenerOffsetDeTimezone(timezone);
  const horasOffset = offset < 0 ? Math.abs(offset) : 0;
  return new Date(fecha + `T${horasOffset.toString().padStart(2, '0')}:00:00Z`);
}

function reemplazarExpresionesTemporalesPorFecha(texto: string): string {
  const ahora = new Date();
  const offsetRD = -4;
  const utc = ahora.getTime() + (ahora.getTimezoneOffset() * 60000);
  const fechaRD = new Date(utc + (offsetRD * 60 * 60 * 1000));

  const fechaISO = formatearFechaYYYYMMDD(fechaRD);
  const ayer = new Date(fechaRD); ayer.setDate(fechaRD.getDate() - 1);
  const fechaAyer = formatearFechaYYYYMMDD(ayer);
  const manana = new Date(fechaRD); manana.setDate(fechaRD.getDate() + 1);
  const fechaManana = formatearFechaYYYYMMDD(manana);
  const pasadoManana = new Date(fechaRD); pasadoManana.setDate(fechaRD.getDate() + 2);
  const fechaPasadoManana = formatearFechaYYYYMMDD(pasadoManana);
  const anteayer = new Date(fechaRD); anteayer.setDate(fechaRD.getDate() - 2);
  const fechaAnteayer = formatearFechaYYYYMMDD(anteayer);

  const textoLimpio = texto.trim().toLowerCase();
  if (textoLimpio === 'hoy' || textoLimpio === 'enhoy') return fechaISO;
  if (textoLimpio === 'ayer') return fechaAyer;
  if (textoLimpio === 'mañana' || textoLimpio === 'manana') return fechaManana;
  if (textoLimpio === 'anteayer') return fechaAnteayer;
  if (textoLimpio === 'pasado mañana' || textoLimpio === 'pasado manana') return fechaPasadoManana;

  return texto
    .replace(/\benhoy\b/gi, fechaISO).replace(/\benhoy día\b/gi, fechaISO)
    .replace(/\benhoy mismo\b/gi, fechaISO).replace(/\benhoy en día\b/gi, fechaISO)
    .replace(/\ben el día de hoy\b/gi, fechaISO).replace(/\bhoy\b/gi, fechaISO)
    .replace(/\ben el día de ayer\b/gi, fechaAyer).replace(/\bayer\b/gi, fechaAyer)
    .replace(/\banteayer\b/gi, fechaAnteayer)
    .replace(/\bmañana\b/gi, fechaManana).replace(/\bmanana\b/gi, fechaManana)
    .replace(/\bpasado mañana\b/gi, fechaPasadoManana).replace(/\bpasado manana\b/gi, fechaPasadoManana);
}

function normalizarFecha(fecha: string): string | null {
  if (!fecha) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return fecha;
  if (/^\d{4}\/\d{2}\/\d{2}$/.test(fecha)) return fecha.replace(/\//g, '-');
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(fecha)) { const [d, m, y] = fecha.split('/'); return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`; }
  if (/^\d{2}-\d{2}-\d{4}$/.test(fecha)) { const [d, m, y] = fecha.split('-'); return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`; }
  const meses = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
  const matchConAño = fecha.match(/(\d{1,2})\s*de\s*([a-záéíóúñ]+)\s*de\s*(\d{4})/i);
  if (matchConAño) {
    const d = matchConAño[1].padStart(2, '0');
    const m = (meses.findIndex(mes => mes === matchConAño[2].toLowerCase()) + 1).toString().padStart(2, '0');
    return `${matchConAño[3]}-${m}-${d}`;
  }
  const matchSinAño = fecha.match(/(\d{1,2})\s*de\s*([a-záéíóúñ]+)$/i);
  if (matchSinAño) {
    const d = matchSinAño[1].padStart(2, '0');
    const mesIndex = meses.findIndex(mes => mes === matchSinAño[2].toLowerCase());
    if (mesIndex !== -1) {
      const m = (mesIndex + 1).toString().padStart(2, '0');
      return `${new Date().getFullYear()}-${m}-${d}`;
    }
  }
  if (/^\d{4}\.\d{2}\.\d{2}$/.test(fecha)) return fecha.replace(/\./g, '-');
  if (/^\d{2}\.\d{2}\.\d{4}$/.test(fecha)) { const [d, m, y] = fecha.split('.'); return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`; }
  if (/^\d{8}$/.test(fecha)) return `${fecha.slice(0,4)}-${fecha.slice(4,6)}-${fecha.slice(6,8)}`;
  return null;
}

function procesarFechasEnDatosTransaccion(data: any, timezone?: string, includeProcessedDate: boolean = true): any {
  if (!data) return data;
  const datosProcesados = { ...data };
  if (datosProcesados.date && typeof datosProcesados.date === 'string') {
    let fechaNormalizada = normalizarFecha(datosProcesados.date);
    if (!fechaNormalizada) {
      fechaNormalizada = reemplazarExpresionesTemporalesPorFecha(datosProcesados.date);
      if (fechaNormalizada === datosProcesados.date) fechaNormalizada = null;
    }
    if (fechaNormalizada) {
      datosProcesados.date = fechaNormalizada;
      if (includeProcessedDate && timezone) {
        datosProcesados._processedDate = procesarFechaConZonaHoraria(fechaNormalizada, timezone);
      }
    }
  }
  return datosProcesados;
}

function normalizarTexto(texto: string): string {
  return texto.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

// =============================================
// VALIDACIONES
// =============================================

function validateTransactionData(data: any): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!data.amount) errors.push('Amount es requerido');
  else if (isNaN(parseFloat(data.amount)) || parseFloat(data.amount) <= 0) errors.push('Amount debe ser un número positivo');
  if (!data.type) errors.push('Type es requerido');
  else if (!['gasto', 'ingreso'].includes(data.type)) errors.push('Type debe ser "gasto" o "ingreso"');
  if (!data.category) errors.push('Category es requerida');
  if (data.date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data.date)) errors.push('Date debe estar en formato YYYY-MM-DD');
    else { const d = new Date(data.date); if (isNaN(d.getTime())) errors.push('Date debe ser una fecha válida'); else if (d < new Date('2020-01-01')) errors.push('Date no puede ser anterior al año 2020'); }
  }
  return { valid: errors.length === 0, errors };
}

function validateCriterios(criterios: any): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const validFields = ['amount', 'category', 'date', 'type', 'description', 'id'];
  if (!criterios || typeof criterios !== 'object') { errors.push('Criterios de identificación es requerido y debe ser un objeto'); return { valid: false, errors }; }
  const providedFields = Object.keys(criterios);
  if (providedFields.length < 2) errors.push('Se requieren al menos 2 criterios de identificación');
  const invalidFields = providedFields.filter(f => !validFields.includes(f));
  if (invalidFields.length > 0) errors.push(`Campos inválidos en criterios: ${invalidFields.join(', ')}`);
  providedFields.forEach(f => { if (criterios[f] === null || criterios[f] === undefined || criterios[f] === '') errors.push(`El criterio ${f} no puede estar vacío`); });
  return { valid: errors.length === 0, errors };
}

async function validateCategory(categoryName: string, type: string, availableCategories?: any[]): Promise<{ valid: boolean; error?: string; categoryId?: string; suggestions?: string[] }> {
  try {
    if (availableCategories && availableCategories.length > 0) {
      const dbType = type === 'gasto' ? 'EXPENSE' : 'INCOME';
      const foundCategory = availableCategories.find((cat: any) => {
        const catName = typeof cat === 'object' && cat.name ? cat.name : cat;
        return normalizarTexto(catName) === normalizarTexto(categoryName);
      });
      if (foundCategory) {
        if (typeof foundCategory === 'object' && foundCategory.id) return { valid: true, categoryId: foundCategory.id };
        const cleanName = typeof foundCategory === 'object' && foundCategory.name ? foundCategory.name : foundCategory;
        const allCategories = await prisma.category.findMany({ where: { type: dbType } });
        const category = allCategories.find(cat => normalizarTexto(cat.name) === normalizarTexto(cleanName));
        if (category) return { valid: true, categoryId: category.id };
      } else {
        const suggestions = availableCategories.map((cat: any) => typeof cat === 'object' && cat.name ? cat.name : cat);
        return { valid: false, error: `No se encontró la categoría "${categoryName}". Elige una de las siguientes: ${suggestions.join(', ')}`, suggestions };
      }
    } else {
      const dbType = type === 'gasto' ? 'EXPENSE' : 'INCOME';
      const allCategories = await prisma.category.findMany({ where: { type: dbType } });
      const category = allCategories.find(cat => normalizarTexto(cat.name) === normalizarTexto(categoryName));
      if (category) return { valid: true, categoryId: category.id };
      else return { valid: false, error: `No se encontró la categoría "${categoryName}".`, suggestions: allCategories.map(c => c.name) };
    }
    return { valid: false, error: 'Categoría no válida' };
  } catch { return { valid: false, error: 'Error al validar la categoría' }; }
}

function validateGoalData(data: any): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!data.name) errors.push('Name es requerido');
  else if (typeof data.name !== 'string' || data.name.trim().length === 0) errors.push('Name debe ser un texto válido');
  if (!data.target_amount) errors.push('Target_amount es requerido');
  else if (isNaN(parseFloat(data.target_amount)) || parseFloat(data.target_amount) <= 0) errors.push('Target_amount debe ser un número positivo');
  if (!data.category) errors.push('Category es requerida');
  if (data.monthly_type && !['porcentaje', 'fijo'].includes(data.monthly_type)) errors.push('Monthly_type debe ser "porcentaje" o "fijo"');
  if (data.monthly_value) {
    if (isNaN(parseFloat(data.monthly_value)) || parseFloat(data.monthly_value) <= 0) errors.push('Monthly_value debe ser un número positivo');
    if (data.monthly_type === 'porcentaje' && parseFloat(data.monthly_value) > 100) errors.push('Monthly_value no puede ser mayor a 100%');
  }
  if (data.due_date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data.due_date)) errors.push('Due_date debe estar en formato YYYY-MM-DD');
    else { const d = new Date(data.due_date); if (isNaN(d.getTime())) errors.push('Due_date debe ser una fecha válida'); }
  }
  if (data.priority && !['Alta', 'Media', 'Baja'].includes(data.priority)) errors.push('Priority debe ser "Alta", "Media" o "Baja"');
  return { valid: errors.length === 0, errors };
}

function validateGoalCriterios(criterios: any): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const validFields = ['name', 'category', 'target_amount', 'due_date'];
  if (!criterios || typeof criterios !== 'object') { errors.push('Criterios de identificación es requerido'); return { valid: false, errors }; }
  const providedFields = Object.keys(criterios);
  if (providedFields.length < 1) errors.push('Se requiere al menos 1 criterio');
  const invalidFields = providedFields.filter(f => !validFields.includes(f));
  if (invalidFields.length > 0) errors.push(`Campos inválidos: ${invalidFields.join(', ')}`);
  providedFields.forEach(f => { if (criterios[f] === null || criterios[f] === undefined || criterios[f] === '') errors.push(`El criterio ${f} no puede estar vacío`); });
  return { valid: errors.length === 0, errors };
}

// =============================================
// FUNCIONES DE EJECUCIÓN DE TOOLS (lógica de negocio)
// =============================================

async function executeOnboardingFinanciero(args: any, userId: string, userName: string): Promise<any> {
  await prisma.onboarding.upsert({
    where: { userId },
    update: {
      mainGoals: args.meta_financiera,
      mainChallenge: args.desafio_financiero,
      mainChallengeOther: args.desafio_financiero?.toLowerCase().includes('otro') ? args.desafio_financiero : undefined,
      savingHabit: args.habito_ahorro,
      emergencyFund: args.fondo_emergencia,
      financialFeeling: args.sentir_financiero,
      incomeRange: args.rango_ingresos,
    },
    create: {
      userId,
      mainGoals: args.meta_financiera,
      mainChallenge: args.desafio_financiero,
      mainChallengeOther: args.desafio_financiero?.toLowerCase().includes('otro') ? args.desafio_financiero : undefined,
      savingHabit: args.habito_ahorro,
      emergencyFund: args.fondo_emergencia,
      financialFeeling: args.sentir_financiero,
      incomeRange: args.rango_ingresos,
    },
  });

  await prisma.user.update({
    where: { id: userId },
    data: { onboarding: true, onboardingCompleted: true },
  });

  return {
    success: true,
    message: `¡Perfecto ${userName}! Tu perfil ha sido registrado. Ahora puedo ofrecerte recomendaciones ajustadas a tu situación.`,
    onboardingCompleted: true,
  };
}

async function executeManageTransactionRecord(args: any, userId: string, categories?: any[], timezone?: string): Promise<any> {
  let transactionData = args.transaction_data;
  const operation = args.operation;
  let criterios = args.criterios_identificacion || {};
  const filtros = args.filtros_busqueda;

  if (transactionData) transactionData = procesarFechasEnDatosTransaccion(transactionData, timezone, true);
  if (criterios && Object.keys(criterios).length > 0) criterios = procesarFechasEnDatosTransaccion(criterios, timezone, false);
  if (filtros?.date) filtros.date = reemplazarExpresionesTemporalesPorFecha(filtros.date);
  if (filtros?.date_from) filtros.date_from = reemplazarExpresionesTemporalesPorFecha(filtros.date_from);
  if (filtros?.date_to) filtros.date_to = reemplazarExpresionesTemporalesPorFecha(filtros.date_to);

  if (!['insert', 'update', 'delete', 'list'].includes(operation)) throw new Error('Operación inválida');

  if (operation === 'insert') {
    const v = validateTransactionData(transactionData);
    if (!v.valid) throw new Error(`Datos inválidos: ${v.errors.join(', ')}`);
  }
  if (operation === 'update' || operation === 'delete') {
    const v = validateCriterios(criterios);
    if (!v.valid) throw new Error(`Criterios inválidos: ${v.errors.join(', ')}`);
  }

  switch (operation) {
    case 'insert': return await insertTransaction(transactionData, userId, categories);
    case 'update': return await updateTransaction(transactionData, criterios, userId, categories);
    case 'delete': return await deleteTransaction(criterios, userId, categories);
    case 'list': return await listTransactions(transactionData, userId, categories, filtros);
    default: throw new Error('Operación no soportada');
  }
}

async function executeManageBudgetRecord(args: any, userId: string, categories?: any[]): Promise<any> {
  const { operation, category, amount, previous_amount, recurrence } = args;
  const filtros = args.filtros_busqueda;

  if (!['insert', 'update', 'delete', 'list'].includes(operation)) throw new Error('Operación inválida');
  if (!category && operation !== 'list') throw new Error('La categoría es requerida');
  if (operation === 'insert' && !amount) throw new Error('El monto es requerido para crear un presupuesto');
  if (operation === 'update' && (!amount || !previous_amount)) throw new Error('El monto anterior y el nuevo monto son requeridos');
  if (operation === 'delete' && !previous_amount) throw new Error('El monto del presupuesto a eliminar es requerido');
  if (recurrence && !['semanal', 'mensual', 'anual'].includes(recurrence)) throw new Error('La recurrencia debe ser: semanal, mensual o anual');

  switch (operation) {
    case 'insert': return await insertBudget(category, amount, recurrence, userId, categories);
    case 'update': return await updateBudget(category, previous_amount, amount, userId, categories);
    case 'delete': return await deleteBudget(category, previous_amount, userId, categories);
    case 'list': return await listBudgets(category, userId, categories, filtros);
    default: throw new Error('Operación no soportada');
  }
}

async function executeManageGoalRecord(args: any, userId: string, categories?: any[]): Promise<any> {
  const { operation, goal_data, criterios_identificacion } = args;
  const filtros = args.filtros_busqueda;

  if (!['insert', 'update', 'delete', 'list'].includes(operation)) throw new Error('Operación inválida');
  if ((operation === 'insert' || operation === 'update') && !goal_data) throw new Error('Goal_data es requerido');
  if ((operation === 'insert' || operation === 'update')) {
    const v = validateGoalData(goal_data);
    if (!v.valid) throw new Error(`Datos inválidos: ${v.errors.join(', ')}`);
  }
  if ((operation === 'update' || operation === 'delete') && !criterios_identificacion) throw new Error('Criterios requeridos');
  if (operation === 'update' || operation === 'delete') {
    const v = validateGoalCriterios(criterios_identificacion);
    if (!v.valid) throw new Error(`Criterios inválidos: ${v.errors.join(', ')}`);
  }
  if (filtros?.due_date_from) filtros.due_date_from = reemplazarExpresionesTemporalesPorFecha(filtros.due_date_from);
  if (filtros?.due_date_to) filtros.due_date_to = reemplazarExpresionesTemporalesPorFecha(filtros.due_date_to);

  switch (operation) {
    case 'insert': return await insertGoal(goal_data, userId, categories);
    case 'update': return await updateGoal(goal_data, criterios_identificacion, userId, categories);
    case 'delete': return await deleteGoal(criterios_identificacion, userId, categories);
    case 'list': return await listGoals(goal_data, userId, categories, filtros);
    default: throw new Error('Operación no soportada');
  }
}

async function executeListCategories(args: any, categories?: any[]): Promise<any> {
  const { module } = args;
  if (!categories || categories.length === 0) {
    try {
      categories = await prisma.category.findMany({ select: { name: true, type: true } });
    } catch {
      return { error: true, message: 'Error al obtener categorías de la base de datos' };
    }
  }

  let filteredCategories: any[] = [];
  switch (module) {
    case 'presupuestos':
      filteredCategories = categories!.filter((cat: any) => typeof cat === 'object' ? cat.type === 'EXPENSE' : true);
      break;
    case 'transacciones':
    case 'metas':
      filteredCategories = categories!;
      break;
    default:
      return { error: true, message: `Módulo no válido: ${module}. Válidos: presupuestos, transacciones, metas` };
  }

  const formattedCategories = filteredCategories.map((cat: any) => typeof cat === 'object' && cat.name ? cat.name : cat);
  return { categories: formattedCategories, count: formattedCategories.length, module };
}

// =============================================
// CRUD TRANSACCIONES
// =============================================

async function insertTransaction(transactionData: any, userId: string, categories?: any[]): Promise<any> {
  const type = transactionData.type === 'gasto' ? 'EXPENSE' : 'INCOME';
  const amount = parseFloat(transactionData.amount);
  const categoryName = transactionData.category;

  const ahora = new Date();
  const offsetRD = -4;
  const utc = ahora.getTime() + (ahora.getTimezoneOffset() * 60000);
  const fechaRD = new Date(utc + (offsetRD * 60 * 60 * 1000));

  let date = fechaRD;
  if (transactionData.date) {
    const fechaMinima = new Date('2020-01-01');
    if (transactionData._processedDate) {
      date = transactionData._processedDate;
    } else {
      const fechaLocal = new Date(transactionData.date + 'T00:00:00');
      const fechaUTC = new Date(fechaLocal.getTime() - (fechaLocal.getTimezoneOffset() * 60000));
      if (fechaUTC >= fechaMinima) date = fechaUTC;
    }
  }

  const description = transactionData.description || '';
  const categoryValidation = await validateCategory(categoryName, transactionData.type, categories);
  if (!categoryValidation.valid) {
    return {
      success: false,
      message: `Categoría no encontrada: "${categoryName}". Categorías disponibles: ${categoryValidation.suggestions?.join(', ')}`,
      suggestions: categoryValidation.suggestions,
      action: 'category_not_found',
    };
  }

  const newTransaction = await prisma.transaction.create({
    data: { userId, amount, type, category_id: categoryValidation.categoryId!, description, date },
    select: { id: true, amount: true, type: true, category: true, description: true, date: true, createdAt: true, updatedAt: true },
  });

  if (type === 'EXPENSE') {
    try {
      await recalculateBudgetSpent(userId, categoryValidation.categoryId!, date);
      await NotificationService.checkBudgetAlerts(userId, categoryValidation.categoryId!, amount, date);
    } catch (error) { logger.error('[ZenioV2 insertTransaction] Error recalculando presupuesto:', error); }
  }

  try {
    const { analyzeAndDispatchTransactionEvents } = await import('./transactions');
    await analyzeAndDispatchTransactionEvents(userId, newTransaction);
  } catch (error) { logger.error('[ZenioV2] Error dispatching gamification event:', error); }

  const categoryRecord = await prisma.category.findUnique({ where: { id: categoryValidation.categoryId! } });

  return {
    success: true,
    message: `Transacción registrada: ${type === 'INCOME' ? 'Ingreso' : 'Gasto'} de RD$${amount.toLocaleString('es-DO')} en ${categoryRecord?.name || categoryName} el ${date.toLocaleDateString('es-ES')}`,
    transaction: newTransaction,
    action: 'transaction_created',
  };
}

async function updateTransaction(transactionData: any, criterios: any, userId: string, categories?: any[]): Promise<any> {
  let where: any = { userId };

  for (const [key, value] of Object.entries(criterios)) {
    if (key === 'amount' || key === 'oldAmount') where.amount = parseFloat(value as string);
    else if (key === 'type') where.type = value === 'gasto' ? 'EXPENSE' : 'INCOME';
    else if (key === 'category') {
      const cat = await prisma.category.findFirst({ where: { name: { equals: value as string, mode: 'insensitive' } } });
      if (cat) { where.category_id = cat.id; }
      else {
        const all = await prisma.category.findMany();
        const found = all.find(c => normalizarTexto(c.name) === normalizarTexto(value as string));
        where.category_id = found ? found.id : '___NO_MATCH___';
      }
    } else if (key === 'date') {
      const fn = normalizarFecha(value as string);
      if (fn) { const s = new Date(fn + 'T00:00:00'); const e = new Date(s); e.setUTCDate(e.getUTCDate() + 1); where.date = { gte: s, lt: e }; }
    } else if (key === 'description') where.description = { contains: value as string, mode: 'insensitive' };
    else if (key === 'id') where.id = value;
  }

  const candidates = await prisma.transaction.findMany({ where, orderBy: { createdAt: 'desc' }, include: { category: { select: { id: true, name: true, icon: true, type: true } } } });
  if (candidates.length === 0) throw new Error('No se encontró ninguna transacción con los criterios proporcionados');
  if (candidates.length > 1) throw new Error('Se encontraron varias transacciones. Proporciona más detalles');

  const trans = candidates[0];
  const updateData: any = {};

  if (transactionData.amount) { const a = parseFloat(transactionData.amount); if (isNaN(a) || a <= 0) throw new Error('Amount debe ser positivo'); updateData.amount = a; }
  if (transactionData.type) { if (!['gasto', 'ingreso'].includes(transactionData.type)) throw new Error('Type inválido'); updateData.type = transactionData.type === 'gasto' ? 'EXPENSE' : 'INCOME'; }
  if (transactionData.category) {
    const cv = await validateCategory(transactionData.category, transactionData.type || 'gasto', categories);
    if (!cv.valid) return { success: false, message: `Categoría no encontrada: "${transactionData.category}"`, suggestions: cv.suggestions, action: 'category_not_found' };
    updateData.category_id = cv.categoryId;
  }
  if (transactionData.date) { if (!/^\d{4}-\d{2}-\d{2}$/.test(transactionData.date)) throw new Error('Formato de fecha debe ser YYYY-MM-DD'); updateData.date = new Date(transactionData.date); }
  if (transactionData.description !== undefined) updateData.description = transactionData.description;

  const updated = await prisma.transaction.update({ where: { id: trans.id }, data: updateData, include: { category: { select: { id: true, name: true, icon: true, type: true } } } });

  // Sistema de aprendizaje: mapeo de merchant
  if (updateData.category_id && trans.category_id !== updateData.category_id) {
    const merchantName = trans.description || updated.description;
    if (merchantName && merchantName.trim().length > 2) {
      try { await merchantMappingService.saveMapping({ userId, merchantName: merchantName.trim(), categoryId: updateData.category_id, source: MappingSource.ZENIO_CORRECTION }); } catch {}
    }
  }

  return { success: true, message: 'Transacción actualizada exitosamente', transaction: updated, action: 'transaction_updated' };
}

async function deleteTransaction(criterios: any, userId: string, categories?: any[]): Promise<any> {
  let where: any = { userId };

  for (const [key, value] of Object.entries(criterios)) {
    if (key === 'amount' || key === 'oldAmount') where.amount = parseFloat(value as string);
    else if (key === 'type') where.type = value === 'gasto' ? 'EXPENSE' : 'INCOME';
    else if (key === 'category') {
      const cat = await prisma.category.findFirst({ where: { name: { equals: value as string, mode: 'insensitive' } } });
      if (cat) { where.category_id = cat.id; }
      else {
        const all = await prisma.category.findMany();
        const found = all.find(c => normalizarTexto(c.name) === normalizarTexto(value as string));
        where.category_id = found ? found.id : '___NO_MATCH___';
      }
    } else if (key === 'date') {
      const fn = normalizarFecha(value as string);
      if (fn) { const s = new Date(fn + 'T00:00:00'); const e = new Date(s); e.setUTCDate(e.getUTCDate() + 1); where.date = { gte: s, lt: e }; }
    } else if (key === 'description') where.description = { contains: value as string, mode: 'insensitive' };
    else if (key === 'id') where.id = value;
  }

  const candidates = await prisma.transaction.findMany({ where, orderBy: { createdAt: 'desc' }, include: { category: { select: { id: true, name: true, icon: true, type: true } } } });
  if (candidates.length === 0) throw new Error('No se encontró ninguna transacción con los criterios proporcionados');
  if (candidates.length > 1) throw new Error('Se encontraron varias transacciones. Proporciona más detalles');

  const trans = candidates[0];
  await prisma.transaction.delete({ where: { id: trans.id } });
  return { success: true, message: 'Transacción eliminada exitosamente', transaction: trans, action: 'transaction_deleted' };
}

async function listTransactions(transactionData: any, userId: string, categories?: string[], filtros?: any): Promise<any> {
  let where: any = { userId };
  let limit: number | undefined;

  if (filtros) {
    if (filtros.limit) { limit = parseInt(filtros.limit); if (isNaN(limit) || limit <= 0 || limit > 100) throw new Error('Limit debe ser entre 1 y 100'); }
    if (filtros.type) { where.type = filtros.type === 'gasto' ? 'EXPENSE' : 'INCOME'; }
    if (filtros.category) { const cat = await prisma.category.findFirst({ where: { name: { equals: filtros.category, mode: 'insensitive' } } }); if (cat) where.category_id = cat.id; }
    if (filtros.date) { const fn = normalizarFecha(filtros.date); if (fn) { const s = new Date(fn + 'T00:00:00.000Z'); const e = new Date(s); e.setUTCDate(e.getUTCDate() + 1); where.date = { gte: s, lt: e }; } }
    if (filtros.date_from || filtros.date_to) {
      const dr: any = {};
      if (filtros.date_from) { const fn = normalizarFecha(filtros.date_from); if (fn) dr.gte = new Date(fn + 'T00:00:00.000Z'); }
      if (filtros.date_to) { const fn = normalizarFecha(filtros.date_to); if (fn) { const e = new Date(fn + 'T00:00:00.000Z'); e.setUTCDate(e.getUTCDate() + 1); dr.lt = e; } }
      if (Object.keys(dr).length > 0) where.date = dr;
    }
  }

  if (transactionData) {
    if (transactionData.amount) { const a = parseFloat(transactionData.amount); if (!isNaN(a) && a > 0) where.amount = a; }
    if (transactionData.type) where.type = transactionData.type === 'gasto' ? 'EXPENSE' : 'INCOME';
    if (transactionData.category) { const cat = await prisma.category.findFirst({ where: { name: { equals: transactionData.category, mode: 'insensitive' } } }); if (cat) where.category_id = cat.id; }
    if (transactionData.date) { const fn = normalizarFecha(transactionData.date); if (fn) { const s = new Date(fn + 'T00:00:00.000Z'); const e = new Date(s); e.setUTCDate(e.getUTCDate() + 1); where.date = { gte: s, lt: e }; } }
  }

  const transactions = await prisma.transaction.findMany({
    where, orderBy: { date: 'desc' }, take: limit,
    include: { category: { select: { id: true, name: true, icon: true, type: true, isDefault: true } } },
  });

  let mensaje = '';
  if (transactions.length === 0) { mensaje = 'No se encontraron transacciones con los criterios especificados.'; }
  else {
    mensaje = `${transactions.length} transacciones encontradas:\n\n`;
    mensaje += transactions.map(t => {
      const tipo = t.type === 'EXPENSE' ? 'Gasto' : 'Ingreso';
      return `${tipo}: ${t.description} - RD$${t.amount.toLocaleString('es-DO')} | ${new Date(t.date).toLocaleDateString('es-ES')} | ${t.category.name}`;
    }).join('\n');
  }

  return { success: true, message: mensaje, transactions, action: 'transaction_list' };
}

// =============================================
// CRUD PRESUPUESTOS
// =============================================

async function insertBudget(category: string, amount: string, recurrence: string, userId: string, categories?: any[]): Promise<any> {
  const subscription = await prisma.subscription.findUnique({ where: { userId } });
  const BUDGET_LIMITS: Record<string, number> = { FREE: 3, PREMIUM: -1, PRO: -1 };
  const plan = subscription?.plan || 'FREE';
  const budgetLimit = BUDGET_LIMITS[plan] || 3;

  if (budgetLimit !== -1) {
    const currentCount = await prisma.budget.count({ where: { user_id: userId, is_active: true } });
    if (currentCount >= budgetLimit) {
      return { success: false, message: `Límite de presupuestos alcanzado (${currentCount}/${budgetLimit}). Mejora tu plan para crear más.`, action: 'budget_limit_reached', upgrade: true };
    }
  }

  const periodMap: { [k: string]: string } = { 'semanal': 'weekly', 'mensual': 'monthly', 'anual': 'yearly' };
  const period = periodMap[recurrence] || 'monthly';
  const now = new Date();
  let startDate: Date, endDate: Date;

  if (recurrence === 'semanal') {
    const day = now.getDay(); const diff = (day === 0 ? -6 : 1) - day;
    startDate = new Date(now); startDate.setDate(now.getDate() + diff); startDate.setHours(0, 0, 0, 0);
    endDate = new Date(startDate); endDate.setDate(startDate.getDate() + 6); endDate.setHours(23, 59, 59, 999);
  } else if (recurrence === 'anual') {
    startDate = new Date(now.getFullYear(), 0, 1, 0, 0, 0, 0);
    endDate = new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999);
  } else {
    startDate = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
  }

  const cv = await validateCategory(category, 'gasto', categories);
  if (!cv.valid) {
    return { success: false, message: `Categoría no encontrada: "${category}". Disponibles: ${cv.suggestions?.join(', ')}`, suggestions: cv.suggestions, action: 'category_not_found' };
  }

  const newBudget = await prisma.budget.create({
    data: { user_id: userId, name: category, category_id: cv.categoryId!, amount: parseFloat(amount), period, start_date: startDate, end_date: endDate, alert_percentage: 80 },
    include: { category: { select: { id: true, name: true, icon: true, type: true, isDefault: true } } },
  });

  const catRecord = await prisma.category.findUnique({ where: { id: cv.categoryId! } });
  return {
    success: true,
    message: `Presupuesto creado: ${catRecord?.name || category} por RD$${parseFloat(amount).toLocaleString('es-DO')} (${recurrence || 'mensual'})`,
    budget: newBudget, action: 'budget_created',
  };
}

async function updateBudget(category: string, previous_amount: string, amount: string, userId: string, categories?: any[]): Promise<any> {
  if (!previous_amount) throw new Error('El monto anterior es requerido');
  if (!amount) throw new Error('El nuevo monto es requerido');

  const where: any = { user_id: userId, is_active: true };
  const cat = await prisma.category.findFirst({ where: { name: { equals: category, mode: 'insensitive' } } });
  if (cat) { where.category_id = cat.id; }
  else {
    const all = await prisma.category.findMany();
    const found = all.find(c => normalizarTexto(c.name) === normalizarTexto(category));
    where.category_id = found ? found.id : '___NO_MATCH___';
  }
  where.amount = parseFloat(previous_amount);

  const candidates = await prisma.budget.findMany({ where, include: { category: { select: { id: true, name: true, icon: true, type: true } } } });
  if (candidates.length === 0) throw new Error('No se encontró el presupuesto');
  if (candidates.length > 1) throw new Error('Se encontraron varios presupuestos. Especifica más');

  const updated = await prisma.budget.update({ where: { id: candidates[0].id }, data: { amount: parseFloat(amount) }, include: { category: { select: { id: true, name: true, icon: true, type: true } } } });
  return { success: true, message: 'Presupuesto actualizado exitosamente', budget: updated, action: 'budget_updated' };
}

async function deleteBudget(category: string, previous_amount: string, userId: string, categories?: any[]): Promise<any> {
  if (!previous_amount) throw new Error('El monto del presupuesto a eliminar es requerido');

  const where: any = { user_id: userId, is_active: true };
  const cat = await prisma.category.findFirst({ where: { name: { equals: category, mode: 'insensitive' } } });
  if (cat) { where.category_id = cat.id; }
  else {
    const all = await prisma.category.findMany();
    const found = all.find(c => normalizarTexto(c.name) === normalizarTexto(category));
    where.category_id = found ? found.id : '___NO_MATCH___';
  }
  where.amount = parseFloat(previous_amount);

  const candidates = await prisma.budget.findMany({ where, include: { category: { select: { id: true, name: true, icon: true, type: true } } } });
  if (candidates.length === 0) throw new Error('No se encontró el presupuesto');

  await prisma.budget.update({ where: { id: candidates[0].id }, data: { is_active: false } });
  return { success: true, message: 'Presupuesto eliminado exitosamente', budget: candidates[0], action: 'budget_deleted' };
}

async function listBudgets(category: string, userId: string, categories?: any[], filtros?: any): Promise<any> {
  let where: any = { user_id: userId, is_active: true };
  let limit: number | undefined;

  if (filtros) {
    if (filtros.limit) { limit = parseInt(filtros.limit); if (isNaN(limit) || limit <= 0 || limit > 100) throw new Error('Limit inválido'); }
    if (filtros.category) { const c = await prisma.category.findFirst({ where: { name: { equals: filtros.category, mode: 'insensitive' } } }); if (c) where.category_id = c.id; }
    if (filtros.recurrence) { const pm: any = { 'semanal': 'weekly', 'mensual': 'monthly', 'anual': 'yearly' }; where.period = pm[filtros.recurrence] || filtros.recurrence; }
    if (filtros.min_amount) where.amount = { ...(where.amount || {}), gte: parseFloat(filtros.min_amount) };
    if (filtros.max_amount) where.amount = { ...(where.amount || {}), lte: parseFloat(filtros.max_amount) };
  } else if (category) {
    const c = await prisma.category.findFirst({ where: { name: { equals: category, mode: 'insensitive' } } });
    if (c) where.category_id = c.id;
  }

  // Filtrar por período actual (mes actual)
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
  where.start_date = { lte: monthEnd };
  where.end_date = { gte: monthStart };

  const budgets = await prisma.budget.findMany({
    where, orderBy: { created_at: 'desc' }, take: limit,
    include: { category: { select: { id: true, name: true, icon: true, type: true, isDefault: true } } },
  });

  let mensaje = '';
  if (budgets.length === 0) { mensaje = 'No se encontraron presupuestos.'; }
  else {
    mensaje = `${budgets.length} presupuestos encontrados:\n\n`;
    mensaje += budgets.map((b: any) => `${b.category.name}: RD$${b.spent?.toLocaleString('es-DO') || '0'}/${b.amount.toLocaleString('es-DO')} (${b.period})`).join('\n');
  }

  return { success: true, message: mensaje, budgets, action: 'budget_list' };
}

// =============================================
// CRUD METAS
// =============================================

async function insertGoal(goalData: any, userId: string, categories?: any[]): Promise<any> {
  const subscription = await prisma.subscription.findUnique({ where: { userId } });
  const GOAL_LIMITS: Record<string, number> = { FREE: 2, PREMIUM: -1, PRO: -1 };
  const plan = subscription?.plan || 'FREE';
  const goalLimit = GOAL_LIMITS[plan] || 2;

  if (goalLimit !== -1) {
    const currentCount = await prisma.goal.count({ where: { userId, isActive: true } });
    if (currentCount >= goalLimit) {
      return { success: false, message: `Límite de metas alcanzado (${currentCount}/${goalLimit}). Mejora tu plan.`, action: 'goal_limit_reached', upgrade: true };
    }
  }

  const cv = await validateCategory(goalData.category, 'gasto', categories);
  if (!cv.valid) {
    return { success: false, message: `Categoría no encontrada: "${goalData.category}". Disponibles: ${cv.suggestions?.join(', ')}`, suggestions: cv.suggestions, action: 'category_not_found' };
  }

  const newGoal = await prisma.goal.create({
    data: {
      userId, name: goalData.name, targetAmount: parseFloat(goalData.target_amount), currentAmount: 0,
      categoryId: cv.categoryId!,
      monthlyTargetPercentage: goalData.monthly_type === 'porcentaje' ? parseFloat(goalData.monthly_value) : null,
      monthlyContributionAmount: goalData.monthly_type === 'fijo' ? parseFloat(goalData.monthly_value) : null,
      targetDate: goalData.due_date ? new Date(goalData.due_date) : null,
      priority: goalData.priority || 'Media', description: goalData.description || '',
      isCompleted: false, isActive: true, contributionsCount: 0,
    },
    include: { category: { select: { id: true, name: true, icon: true, type: true } } },
  });

  return {
    success: true,
    message: `Meta creada: "${goalData.name}" por RD$${parseFloat(goalData.target_amount).toLocaleString('es-DO')}`,
    goal: newGoal, action: 'goal_created',
  };
}

async function updateGoal(goalData: any, criterios: any, userId: string, categories?: any[]): Promise<any> {
  let where: any = { userId, isActive: true };

  if (criterios.name) where.name = { contains: criterios.name, mode: 'insensitive' };
  if (criterios.category) {
    const c = await prisma.category.findFirst({ where: { name: { equals: criterios.category, mode: 'insensitive' } } });
    if (c) where.categoryId = c.id;
  }
  if (criterios.target_amount) where.targetAmount = parseFloat(criterios.target_amount);
  if (criterios.due_date) {
    const fn = normalizarFecha(criterios.due_date);
    if (fn) { const s = new Date(fn + 'T00:00:00'); const e = new Date(s); e.setUTCDate(e.getUTCDate() + 1); where.targetDate = { gte: s, lt: e }; }
  }

  const candidates = await prisma.goal.findMany({ where, include: { category: { select: { id: true, name: true, icon: true, type: true } } } });
  if (candidates.length === 0) throw new Error('No se encontró la meta');
  if (candidates.length > 1) throw new Error('Se encontraron varias metas. Especifica más');

  const updateData: any = {};
  if (goalData.name) updateData.name = goalData.name;
  if (goalData.target_amount) updateData.targetAmount = parseFloat(goalData.target_amount);
  if (goalData.category) {
    const cv = await validateCategory(goalData.category, 'gasto', categories);
    if (cv.valid) updateData.categoryId = cv.categoryId;
  }
  if (goalData.due_date) updateData.targetDate = new Date(goalData.due_date);
  if (goalData.priority) updateData.priority = goalData.priority;
  if (goalData.description !== undefined) updateData.description = goalData.description;
  if (goalData.monthly_type === 'porcentaje') { updateData.monthlyTargetPercentage = parseFloat(goalData.monthly_value); updateData.monthlyContributionAmount = null; }
  if (goalData.monthly_type === 'fijo') { updateData.monthlyContributionAmount = parseFloat(goalData.monthly_value); updateData.monthlyTargetPercentage = null; }

  const updated = await prisma.goal.update({ where: { id: candidates[0].id }, data: updateData, include: { category: { select: { id: true, name: true, icon: true, type: true } } } });
  return { success: true, message: 'Meta actualizada exitosamente', goal: updated, action: 'goal_updated' };
}

async function deleteGoal(criterios: any, userId: string, categories?: any[]): Promise<any> {
  let where: any = { userId, isActive: true };

  if (criterios.name) where.name = { contains: criterios.name, mode: 'insensitive' };
  if (criterios.category) {
    const c = await prisma.category.findFirst({ where: { name: { equals: criterios.category, mode: 'insensitive' } } });
    if (c) where.categoryId = c.id;
  }
  if (criterios.target_amount) where.targetAmount = parseFloat(criterios.target_amount);
  if (criterios.due_date) {
    const fn = normalizarFecha(criterios.due_date);
    if (fn) { const s = new Date(fn + 'T00:00:00'); const e = new Date(s); e.setUTCDate(e.getUTCDate() + 1); where.targetDate = { gte: s, lt: e }; }
  }

  const candidates = await prisma.goal.findMany({ where, include: { category: { select: { id: true, name: true, icon: true, type: true } } } });
  if (candidates.length === 0) throw new Error('No se encontró la meta');
  if (candidates.length > 1) throw new Error('Se encontraron varias metas. Especifica más');

  await prisma.goal.update({ where: { id: candidates[0].id }, data: { isActive: false } });
  return { success: true, message: 'Meta eliminada exitosamente', goal: candidates[0], action: 'goal_deleted' };
}

async function listGoals(goalData: any, userId: string, categories?: any[], filtros?: any): Promise<any> {
  let where: any = { userId, isActive: true };
  let limit: number | undefined;

  if (filtros) {
    if (filtros.limit) { limit = parseInt(filtros.limit); if (isNaN(limit) || limit <= 0 || limit > 100) throw new Error('Limit inválido'); }
    if (filtros.category) { const c = await prisma.category.findFirst({ where: { name: { equals: filtros.category, mode: 'insensitive' } } }); if (c) where.categoryId = c.id; }
    if (filtros.priority) where.priority = filtros.priority;
    if (filtros.min_amount) where.targetAmount = { ...(where.targetAmount || {}), gte: parseFloat(filtros.min_amount) };
    if (filtros.max_amount) where.targetAmount = { ...(where.targetAmount || {}), lte: parseFloat(filtros.max_amount) };
    if (filtros.due_date_from) { const fn = normalizarFecha(filtros.due_date_from); if (fn) where.targetDate = { ...(where.targetDate || {}), gte: new Date(fn) }; }
    if (filtros.due_date_to) { const fn = normalizarFecha(filtros.due_date_to); if (fn) where.targetDate = { ...(where.targetDate || {}), lte: new Date(fn) }; }
    if (filtros.status === 'completada') where.isCompleted = true;
    if (filtros.status === 'activa') where.isCompleted = false;
  }

  const goals = await prisma.goal.findMany({
    where, orderBy: { createdAt: 'desc' }, take: limit,
    include: { category: { select: { id: true, name: true, icon: true, type: true } } },
  });

  let mensaje = '';
  if (goals.length === 0) { mensaje = 'No se encontraron metas.'; }
  else {
    mensaje = `${goals.length} metas encontradas:\n\n`;
    mensaje += goals.map(g => {
      const progreso = g.targetAmount > 0 ? Math.round((g.currentAmount / g.targetAmount) * 100) : 0;
      return `${g.name}: RD$${g.currentAmount.toLocaleString('es-DO')}/${g.targetAmount.toLocaleString('es-DO')} (${progreso}%) | ${g.category.name} | Prioridad: ${g.priority}`;
    }).join('\n');
  }

  return { success: true, message: mensaje, goals, action: 'goal_list' };
}

// =============================================
// PROCESAMIENTO DE FUNCTION CALLS (Responses API)
// =============================================

interface ToolCallResult {
  toolCallId: string;
  result: any;
  action?: string;
}

async function processToolCalls(
  functionCalls: any[],
  userId: string,
  userName: string,
  categories?: any[],
  timezone?: string
): Promise<ToolCallResult[]> {
  const results: ToolCallResult[] = [];

  for (const call of functionCalls) {
    if (call.type !== 'function_call') continue;

    const functionName = call.name;
    const functionArgs = JSON.parse(call.arguments);
    let result: any = null;

    try {
      switch (functionName) {
        case 'onboarding_financiero':
          result = await executeOnboardingFinanciero(functionArgs, userId, userName);
          break;
        case 'manage_transaction_record':
          result = await executeManageTransactionRecord(functionArgs, userId, categories, timezone);
          break;
        case 'manage_budget_record':
          result = await executeManageBudgetRecord(functionArgs, userId, categories);
          break;
        case 'manage_goal_record':
          result = await executeManageGoalRecord(functionArgs, userId, categories);
          break;
        case 'list_categories':
          result = await executeListCategories(functionArgs, categories);
          break;
        default:
          result = { error: true, message: `Función no soportada: ${functionName}` };
      }
    } catch (error: any) {
      logger.error(`[ZenioV2] Error ejecutando ${functionName}:`, error);
      result = { success: false, error: error.message || 'Error desconocido' };
    }

    results.push({
      toolCallId: call.call_id,
      result,
      action: result?.action,
    });
  }

  return results;
}

// =============================================
// CONTROLADOR PRINCIPAL V2 - chatWithZenio
// =============================================

export const chatWithZenioV2 = async (req: Request, res: Response) => {
  try {
    // 1. Validar usuario
    const userId = req.user?.id;
    if (!userId) throw new Error('No se pudo determinar el usuario autenticado.');

    // 2. Obtener info del usuario
    let userName = 'Usuario';
    let user = null;
    try {
      user = await prisma.user.findUnique({ where: { id: userId } });
      userName = user?.name || user?.email || 'Usuario';
    } catch (e) { logger.error('[ZenioV2] Error obteniendo usuario:', e); }

    // 3. Validar límite de consultas Zenio
    const ZENIO_LIMITS: Record<string, number> = { FREE: 10, PREMIUM: -1, PRO: -1 };

    let subscription = await prisma.subscription.findUnique({ where: { userId } });
    if (!subscription) {
      subscription = await prisma.subscription.create({
        data: { userId, plan: 'FREE', status: 'ACTIVE', zenioQueriesUsed: 0, zenioQueriesResetAt: new Date() },
      });
    }

    // Reseteo mensual
    const now = new Date();
    const resetDate = subscription.zenioQueriesResetAt;
    if (!resetDate) {
      subscription = await prisma.subscription.update({ where: { userId }, data: { zenioQueriesResetAt: now } });
    } else if (now.getMonth() !== resetDate.getMonth() || now.getFullYear() !== resetDate.getFullYear()) {
      subscription = await prisma.subscription.update({ where: { userId }, data: { zenioQueriesUsed: 0, zenioQueriesResetAt: now } });
    }

    const zenioLimit = ZENIO_LIMITS[subscription.plan] || 10;
    const currentCount = subscription.zenioQueriesUsed || 0;

    if (zenioLimit !== -1 && currentCount >= zenioLimit) {
      return res.status(403).json({
        success: false, error: 'ZENIO_LIMIT_REACHED',
        message: 'Has alcanzado el límite de consultas de Zenio para este mes.',
        upgrade: true,
        zenioUsage: { used: currentCount, limit: zenioLimit, remaining: 0 },
      });
    }

    // 4. Obtener datos del request
    let { message, threadId: incomingThreadId, isOnboarding, categories, timezone, autoGreeting, transactions } = req.body;
    const userTimezone = timezone || 'UTC';

    // 4.1 Obtener categorías si no vienen del frontend
    if (!categories || categories.length === 0) {
      try {
        categories = await prisma.category.findMany({ select: { id: true, name: true, type: true } });
      } catch { categories = []; }
    }

    // 5. Procesar expresiones temporales
    if (typeof message === 'string') {
      message = reemplazarExpresionesTemporalesPorFecha(message);
    }

    // 6. Construir instrucciones con fecha actual dinámica
    const ahora = new Date();
    const offsetRD = -4;
    const utc = ahora.getTime() + (ahora.getTimezoneOffset() * 60000);
    const fechaRD = new Date(utc + (offsetRD * 60 * 60 * 1000));
    const fechaActual = fechaRD.toISOString().split('T')[0];
    const fechaHumana = fechaRD.toLocaleDateString('es-ES', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

    // Formatear categorías para inyectar en el contexto
    let categoriesContext = '';
    if (categories && categories.length > 0) {
      const expenseCategories: string[] = [];
      const incomeCategories: string[] = [];
      for (const cat of categories) {
        const catName = typeof cat === 'object' && cat.name ? cat.name : cat;
        const catType = typeof cat === 'object' && cat.type ? cat.type : null;
        if (catType === 'EXPENSE') expenseCategories.push(catName);
        else if (catType === 'INCOME') incomeCategories.push(catName);
        else { expenseCategories.push(catName); incomeCategories.push(catName); }
      }
      categoriesContext = `\n\nCATEGORÍAS DISPONIBLES EN LA APP:\n- Gastos: ${expenseCategories.join(', ')}\n- Ingresos: ${incomeCategories.join(', ')}\nUSA SOLO estas categorías. NUNCA inventes categorías que no estén en esta lista. Si el usuario pide ver categorías, muéstrale ESTAS.`;
    }

    const dynamicInstructions = `${ZENIO_SYSTEM_PROMPT}\n\nFECHA ACTUAL: Hoy es ${fechaHumana} (${fechaActual}). Año ${fechaRD.getFullYear()}. Zona horaria: República Dominicana (UTC-4). Cuando el usuario mencione "hoy", "ayer", "mañana", etc., usa esta fecha como referencia.${categoriesContext}`;

    // 7. Construir input para Responses API
    const input: any[] = [];

    // En la primera interacción (sin threadId), agregar contexto del usuario
    const isFirstMessage = !incomingThreadId || typeof incomingThreadId !== 'string';

    if (isFirstMessage) {
      // Contexto del nombre del usuario
      input.push({
        role: 'user',
        content: `El usuario se llama ${userName}. Siempre que lo saludes, hazlo de forma natural y menciona su nombre.`,
      });
      input.push({
        role: 'assistant',
        content: `Entendido, el usuario se llama ${userName}. Lo saludaré por su nombre de forma natural.`,
      });

      // Si es onboarding
      if (isOnboarding && !user?.onboardingCompleted) {
        input.push({
          role: 'user',
          content: `Quiero iniciar mi onboarding financiero. Mi nombre es ${userName}.`,
        });
      } else if (message) {
        input.push({ role: 'user', content: message });
      }
    } else {
      // Conversación existente: solo el mensaje del usuario
      input.push({ role: 'user', content: message });
    }

    // 8. Construir tools para la request
    const tools: any[] = [
      ...ZENIO_FUNCTION_TOOLS,
      {
        type: 'file_search' as const,
        vector_store_ids: [ZENIO_VECTOR_STORE_ID],
      },
    ];

    // 9. Llamar a Responses API
    // previous_response_id = threadId que viene del frontend (es el response ID anterior)
    const previousResponseId = isFirstMessage ? undefined : incomingThreadId;
    let lastKnownResponseId = incomingThreadId || undefined;

    logger.error(`[ZenioV2-DEBUG] Llamando Responses API. isFirst=${isFirstMessage}, previousResponseId=${previousResponseId || 'none'}`);
    logger.error(`[ZenioV2-DEBUG] Input enviado: ${JSON.stringify(input).substring(0, 500)}`);
    logger.error(`[ZenioV2-DEBUG] Tools disponibles: ${tools.map((t: any) => t.name || t.type).join(', ')}`);
    logger.error(`[ZenioV2-DEBUG] Categorías recibidas del frontend: ${categories?.length || 0}`);

    let response: any;
    try {
      response = await openai.responses.create({
        model: ZENIO_MODEL,
        instructions: dynamicInstructions,
        input,
        tools,
        temperature: ZENIO_TEMPERATURE,
        previous_response_id: previousResponseId,
        store: true,
      });
    } catch (initialError: any) {
      // Si el previous_response_id es inválido/expirado, reintentar sin él
      if (initialError?.status === 400 && previousResponseId) {
        logger.warn(`[ZenioV2] previous_response_id inválido (${previousResponseId}), reintentando sin contexto`);
        // Re-agregar el contexto del usuario ya que se pierde la conversación
        const freshInput: any[] = [
          { role: 'user', content: `El usuario se llama ${userName}. Siempre que lo saludes, hazlo de forma natural y menciona su nombre.` },
          { role: 'assistant', content: `Entendido, el usuario se llama ${userName}. Lo saludaré por su nombre de forma natural.` },
          { role: 'user', content: message },
        ];
        response = await openai.responses.create({
          model: ZENIO_MODEL,
          instructions: dynamicInstructions,
          input: freshInput,
          tools,
          temperature: ZENIO_TEMPERATURE,
          store: true,
        });
      } else {
        throw initialError;
      }
    }

    lastKnownResponseId = response.id;

    // LOG: qué devolvió el modelo
    logger.error(`[ZenioV2-DEBUG] Response ID: ${response.id}`);
    logger.error(`[ZenioV2-DEBUG] Output items: ${response.output?.map((item: any) => `${item.type}${item.type === 'function_call' ? `(${item.name})` : ''}`).join(', ')}`);
    logger.error(`[ZenioV2-DEBUG] output_text: ${response.output_text?.substring(0, 300) || '(vacío)'}`);

    // 10. Loop de tool calls (similar a maxSteps)
    let executedActions: any[] = [];
    let toolCallIterations = 0;
    const maxToolCallIterations = 10;

    while (toolCallIterations < maxToolCallIterations) {
      // Buscar function_calls en el output
      const functionCalls = response.output.filter((item: any) => item.type === 'function_call');
      if (functionCalls.length === 0) break;

      toolCallIterations++;
      logger.error(`[ZenioV2-DEBUG] Tool call iteración ${toolCallIterations}, ${functionCalls.length} calls`);
      logger.error(`[ZenioV2-DEBUG] Tool calls: ${functionCalls.map((fc: any) => `${fc.name}(${fc.arguments?.substring(0, 100)})`).join(', ')}`);

      // Procesar todos los tool calls
      const toolResults = await processToolCalls(functionCalls, userId, userName, categories, userTimezone);

      // Recoger acciones ejecutadas
      for (const tr of toolResults) {
        if (tr.action) {
          executedActions.push({ action: tr.action, data: tr.result });
        }
      }

      // Construir input con los resultados de los tools para la siguiente llamada
      const toolOutputs = toolResults.map(tr => ({
        type: 'function_call_output' as const,
        call_id: tr.toolCallId,
        output: JSON.stringify(tr.result),
      }));

      // Llamar de nuevo con los resultados - proteger contra fallo mid-loop
      try {
        response = await openai.responses.create({
          model: ZENIO_MODEL,
          instructions: dynamicInstructions,
          input: toolOutputs,
          tools,
          temperature: ZENIO_TEMPERATURE,
          previous_response_id: response.id,
          store: true,
        });
        lastKnownResponseId = response.id;
      } catch (loopError: any) {
        // Si falla la llamada a OpenAI pero ya ejecutamos acciones, devolver respuesta parcial
        logger.error(`[ZenioV2] Error en loop de tool calls (iteración ${toolCallIterations}):`, loopError);
        if (executedActions.length > 0) {
          const partialMessage = 'Se ejecutaron las acciones solicitadas, pero hubo un problema al generar la respuesta completa. Tus datos fueron guardados correctamente.';
          const partialPayload: any = {
            message: partialMessage,
            threadId: lastKnownResponseId,
            autoGreeting: autoGreeting || false,
            zenioUsage: { used: currentCount, limit: zenioLimit === -1 ? -1 : zenioLimit, remaining: zenioLimit === -1 ? -1 : Math.max(0, zenioLimit - currentCount) },
            executedActions,
          };
          const lastAction = executedActions[executedActions.length - 1];
          partialPayload.action = lastAction.action;
          partialPayload.transaction = lastAction.data?.transaction;
          partialPayload.budget = lastAction.data?.budget;
          partialPayload.goal = lastAction.data?.goal;
          return res.json(partialPayload);
        }
        throw loopError; // Si no hay acciones ejecutadas, propagar el error
      }
    }

    if (toolCallIterations >= maxToolCallIterations) {
      logger.warn('[ZenioV2] Límite máximo de tool call iteraciones alcanzado');
    }

    // 11. Obtener respuesta final
    const assistantResponse = response.output_text || 'No se pudo obtener respuesta del asistente.';

    // 12. Incrementar contador de consultas
    let zenioUsage = { used: 0, limit: 15, remaining: 15 };
    try {
      const sub = await prisma.subscription.findUnique({ where: { userId } });
      if (sub) {
        const { PLANS } = await import('../config/stripe');
        const planLimits = PLANS[sub.plan as keyof typeof PLANS]?.limits;
        const limit = planLimits?.zenioQueries ?? 15;

        if (!autoGreeting && !isOnboarding) {
          const updatedSub = await prisma.subscription.update({ where: { userId }, data: { zenioQueriesUsed: { increment: 1 } } });
          zenioUsage = { used: updatedSub.zenioQueriesUsed, limit, remaining: limit === -1 ? -1 : Math.max(0, limit - updatedSub.zenioQueriesUsed) };
        } else {
          zenioUsage = { used: sub.zenioQueriesUsed || 0, limit, remaining: limit === -1 ? -1 : Math.max(0, limit - (sub.zenioQueriesUsed || 0)) };
        }
      }
    } catch (e) { logger.error('[ZenioV2] Error actualizando contador:', e); }

    // 13. Responder al frontend
    // CLAVE: Devolvemos response.id como threadId para que el frontend lo envíe
    // como previous_response_id en la siguiente interacción
    const responsePayload: any = {
      message: assistantResponse,
      threadId: response.id,
      autoGreeting: autoGreeting || false,
      zenioUsage,
    };

    if (executedActions.length > 0) {
      responsePayload.executedActions = executedActions;
      const lastAction = executedActions[executedActions.length - 1];
      responsePayload.action = lastAction.action;
      responsePayload.transaction = lastAction.data?.transaction;
      responsePayload.budget = lastAction.data?.budget;
      responsePayload.goal = lastAction.data?.goal;
    }

    return res.json(responsePayload);

  } catch (error: any) {
    logger.error('[ZenioV2] Error:', error);

    // Manejo de errores del SDK de OpenAI - incluir threadId en todas las respuestas de error
    const errorThreadId = req.body?.threadId;

    if (error?.status === 401) {
      return res.status(401).json({ message: 'Error de autenticación con OpenAI. API Key inválida.', threadId: errorThreadId });
    }
    if (error?.status === 429) {
      return res.status(429).json({ message: 'Zenio está procesando muchos mensajes. Por favor, espera un momento.', threadId: errorThreadId });
    }
    if (error?.status === 400) {
      // Verificar si es un error de previous_response_id
      const isConversationError = error.message?.includes('previous_response_id') || error.message?.includes('response');
      return res.status(400).json({
        message: isConversationError ? 'La conversación expiró. Por favor, inicia una nueva.' : 'Request inválida a OpenAI.',
        error: isConversationError ? 'CONVERSATION_EXPIRED' : 'BAD_REQUEST',
        threadId: isConversationError ? undefined : errorThreadId, // Sin threadId para que la app reinicie
      });
    }
    if (error?.code === 'ECONNRESET') {
      return res.status(503).json({ message: 'No se pudo conectar con Zenio. Intenta de nuevo.', threadId: errorThreadId });
    }

    return res.status(500).json({
      error: 'Error al comunicarse con Zenio.',
      message: error.message || 'Error desconocido',
      threadId: errorThreadId,
    });
  }
};

// =============================================
// GET CHAT HISTORY V2
// =============================================

export const getChatHistoryV2 = async (req: Request, res: Response) => {
  try {
    const { threadId } = req.query;
    if (!threadId) {
      return res.status(400).json({ error: 'Validation error', message: 'Thread ID (response ID) is required' });
    }

    // Con Responses API, podemos recuperar la respuesta por su ID
    try {
      const response = await openai.responses.retrieve(threadId as string);
      return res.json({
        success: true,
        response: {
          id: response.id,
          output: response.output,
          created_at: response.created_at,
        },
      });
    } catch (error: any) {
      return res.status(404).json({ error: 'Response not found', message: 'No se encontró la conversación' });
    }
  } catch (error) {
    return res.status(500).json({ error: 'Error al recuperar el historial.' });
  }
};

// =============================================
// TRANSCRIBE AUDIO V2 (sin cambios, mismo Whisper)
// =============================================

export const transcribeAudioV2 = async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No audio file provided', message: 'Por favor, envía un archivo de audio' });
    }

    const formData = new FormData();
    const audioStream = fs.createReadStream(req.file.path);
    formData.append('file', audioStream, { filename: req.file.originalname || 'audio.wav', contentType: req.file.mimetype || 'audio/wav' });
    formData.append('model', 'whisper-1');
    formData.append('language', 'es');

    const response: any = await axios.post('https://api.openai.com/v1/audio/transcriptions', formData, {
      headers: { 'Authorization': `Bearer ${ENV.OPENAI_API_KEY}`, ...formData.getHeaders() },
      timeout: 30000,
    });

    fs.unlinkSync(req.file.path);

    return res.json({ transcription: response.data.text || '', success: true });
  } catch (error) {
    logger.error('[TranscribeV2] Error:', error);
    if (req.file?.path) { try { fs.unlinkSync(req.file.path); } catch {} }
    return res.status(500).json({ error: 'Internal server error', message: 'Error al transcribir el audio' });
  }
};

// =============================================
// ENDPOINTS DIRECTOS (crear transacción/presupuesto desde frontend)
// =============================================

export const createTransactionFromZenioV2 = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) throw new Error('No se pudo determinar el usuario autenticado.');

    const { transaction_data, operation } = req.body;
    if (operation !== 'insert') return res.status(400).json({ error: 'Invalid operation', message: 'Only insert supported' });

    const type = transaction_data.type === 'gasto' ? 'EXPENSE' : 'INCOME';
    const amount = parseFloat(transaction_data.amount);
    const category = transaction_data.category;
    const date = transaction_data.date ? new Date(transaction_data.date) : new Date();
    const description = transaction_data.description || '';

    if (!amount || amount <= 0) return res.status(400).json({ error: 'Validation error', message: 'El monto debe ser positivo' });
    if (!category) return res.status(400).json({ error: 'Validation error', message: 'La categoría es requerida' });

    const categoryRecord = await prisma.category.findFirst({ where: { name: category, type } });
    if (!categoryRecord) return res.status(400).json({ error: 'Validation error', message: `No se encontró la categoría "${category}"` });

    const newTransaction = await prisma.transaction.create({
      data: { userId, amount, type, category_id: categoryRecord.id, description, date },
      select: { id: true, amount: true, type: true, category: true, description: true, date: true, createdAt: true, updatedAt: true },
    });

    if (type === 'EXPENSE') {
      try {
        await recalculateBudgetSpent(userId, categoryRecord.id, date);
        await NotificationService.checkBudgetAlerts(userId, categoryRecord.id, amount, date);
      } catch {}
    }

    try {
      const { analyzeAndDispatchTransactionEvents } = await import('./transactions');
      await analyzeAndDispatchTransactionEvents(userId, newTransaction);
    } catch {}

    return res.json({ message: 'Transacción registrada exitosamente', transaction: newTransaction, action: 'transaction_created' });
  } catch (error: any) {
    logger.error('[ZenioV2 createTransaction] Error:', error);
    return res.status(500).json({ error: 'Internal server error', message: 'Error al crear la transacción' });
  }
};

export const createBudgetFromZenioV2 = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) throw new Error('No se pudo determinar el usuario autenticado.');

    const subscription = await prisma.subscription.findUnique({ where: { userId } });
    const BUDGET_LIMITS: Record<string, number> = { FREE: 3, PREMIUM: -1, PRO: -1 };
    const plan = subscription?.plan || 'FREE';
    const budgetLimit = BUDGET_LIMITS[plan] || 3;

    if (budgetLimit !== -1) {
      const count = await prisma.budget.count({ where: { user_id: userId, is_active: true } });
      if (count >= budgetLimit) {
        return res.status(403).json({ success: false, error: 'BUDGET_LIMIT_REACHED', message: 'Límite de presupuestos alcanzado', upgrade: true });
      }
    }

    const { budget_data, operation } = req.body;
    if (operation !== 'insert') return res.status(400).json({ error: 'Invalid operation', message: 'Only insert supported' });

    const validation = validateBudgetData(budget_data);
    if (!validation.valid) return res.status(400).json({ error: 'Datos inválidos', details: validation.errors });

    const cv = await validateCategory(budget_data.category, 'gasto');
    if (!cv.valid) return res.status(400).json({ error: 'Categoría inválida', message: cv.error });

    const newBudget = await prisma.budget.create({
      data: {
        user_id: userId, name: budget_data.name, category_id: cv.categoryId!,
        amount: parseFloat(budget_data.amount), period: budget_data.period,
        start_date: new Date(budget_data.start_date), end_date: new Date(budget_data.end_date),
        alert_percentage: budget_data.alert_percentage || 80,
      },
      include: { category: { select: { id: true, name: true, icon: true, type: true, isDefault: true } } },
    });

    return res.json({ message: 'Presupuesto creado exitosamente', budget: newBudget, action: 'budget_created' });
  } catch (error: any) {
    logger.error('[ZenioV2 createBudget] Error:', error);
    return res.status(500).json({ error: 'Internal server error', message: 'Error al crear el presupuesto' });
  }
};

function validateBudgetData(data: any): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!data.name) errors.push('Name es requerido');
  if (!data.amount || isNaN(parseFloat(data.amount)) || parseFloat(data.amount) <= 0) errors.push('Amount debe ser positivo');
  if (!data.category) errors.push('Category es requerida');
  if (!data.period || !['monthly', 'weekly', 'yearly'].includes(data.period)) errors.push('Period debe ser monthly, weekly o yearly');
  if (!data.start_date || !/^\d{4}-\d{2}-\d{2}$/.test(data.start_date)) errors.push('Start_date inválida');
  if (!data.end_date || !/^\d{4}-\d{2}-\d{2}$/.test(data.end_date)) errors.push('End_date inválida');
  if (data.start_date && data.end_date && new Date(data.start_date) >= new Date(data.end_date)) errors.push('Start_date debe ser antes que end_date');
  return { valid: errors.length === 0, errors };
}
