/**
 * Zenio Agents Controller
 * Implementa la arquitectura de agentes especializados:
 *   Router (código) → Asistente | Educativo | Analista
 *
 * Reutiliza la lógica de OpenAI Responses API y tool calls
 * del controller V2 sin modificarlo.
 *
 * Se activa cuando el frontend envía zenioVersion: 'agents'
 */

import { Request, Response } from 'express';
import OpenAI from 'openai';
import { prisma } from '../lib/prisma';
import { ENV } from '../config/env';
import { logger } from '../utils/logger';
import { ZENIO_MODEL, ZENIO_TEMPERATURE } from '../config/zenioPrompt';
import {
  classifyIntent,
  ZENIO_ASISTENTE_PROMPT,
  ZENIO_EDUCATIVO_PROMPT,
  ZENIO_ANALISTA_PROMPT,
  ASISTENTE_TOOLS,
  EDUCATIVO_TOOLS,
  ANALISTA_TOOLS,
  type AgentType,
} from '../config/agents';

// Cliente OpenAI
const openai = new OpenAI({ apiKey: ENV.OPENAI_API_KEY });

// Importar funciones de ejecución de tool calls
// Nota: Estas funciones están en zenioV2.ts pero no son exportadas.
// Las reimportamos desde las mismas fuentes que usa zenioV2.
import { MappingSource } from '@prisma/client';
import { merchantMappingService } from '../services/merchantMappingService';
import { NotificationService } from '../services/notificationService';
import { recalculateBudgetSpent } from './transactions';

// =============================================
// FUNCIONES DE UTILIDAD (replicadas de zenioV2.ts)
// =============================================

function normalizarTexto(texto: string): string {
  return texto.toLowerCase().trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function reemplazarExpresionesTemporalesPorFecha(message: string): string {
  const ahora = new Date();
  const offsetRD = -4;
  const utc = ahora.getTime() + (ahora.getTimezoneOffset() * 60000);
  const fechaRD = new Date(utc + (offsetRD * 60 * 60 * 1000));

  const hoy = fechaRD.toISOString().split('T')[0];
  const ayer = new Date(fechaRD); ayer.setDate(ayer.getDate() - 1);
  const manana = new Date(fechaRD); manana.setDate(manana.getDate() + 1);
  const ayerStr = ayer.toISOString().split('T')[0];
  const mananaStr = manana.toISOString().split('T')[0];

  let result = message;
  result = result.replace(/\bhoy\b/gi, hoy);
  result = result.replace(/\bayer\b/gi, ayerStr);
  result = result.replace(/\bmañana\b/gi, mananaStr);
  return result;
}

// =============================================
// VALIDACIÓN DE CATEGORÍAS
// =============================================

async function validateCategory(categoryName: string, expectedType: string, categories?: any[]): Promise<{ valid: boolean; categoryId?: string; suggestions?: string[] }> {
  const normalized = normalizarTexto(categoryName);

  // Buscar en categorías del frontend primero
  if (categories && categories.length > 0) {
    const exactMatch = categories.find((c: any) => normalizarTexto(c.name) === normalized);
    if (exactMatch) return { valid: true, categoryId: exactMatch.id };

    const partialMatch = categories.filter((c: any) => normalizarTexto(c.name).includes(normalized) || normalized.includes(normalizarTexto(c.name)));
    if (partialMatch.length === 1) return { valid: true, categoryId: partialMatch[0].id };
    if (partialMatch.length > 1) return { valid: false, suggestions: partialMatch.map((c: any) => c.name) };
  }

  // Buscar en BD
  const allCategories = await prisma.category.findMany();
  const typeFilter = expectedType === 'gasto' ? 'EXPENSE' : expectedType === 'ingreso' ? 'INCOME' : null;
  const filtered = typeFilter ? allCategories.filter(c => c.type === typeFilter) : allCategories;

  const exact = filtered.find(c => normalizarTexto(c.name) === normalized);
  if (exact) return { valid: true, categoryId: exact.id };

  const partial = filtered.filter(c => normalizarTexto(c.name).includes(normalized) || normalized.includes(normalizarTexto(c.name)));
  if (partial.length === 1) return { valid: true, categoryId: partial[0].id };

  return { valid: false, suggestions: filtered.map(c => c.name) };
}

// =============================================
// TOOL CALL HANDLERS (operaciones de BD)
// =============================================

async function handleToolCall(
  call: any,
  userId: string,
  userName: string,
  categories?: any[],
  timezone?: string
): Promise<{ toolCallId: string; result: any; action?: string }> {
  if (call.type !== 'function_call') {
    return { toolCallId: call.call_id, result: { skipped: true } };
  }

  const functionName = call.name;
  const args = JSON.parse(call.arguments);
  let result: any = null;

  try {
    switch (functionName) {
      case 'manage_transaction_record':
        result = await handleTransaction(args, userId, categories, timezone);
        break;
      case 'manage_budget_record':
        result = await handleBudget(args, userId, categories);
        break;
      case 'manage_goal_record':
        result = await handleGoal(args, userId, categories);
        break;
      case 'list_categories':
        result = await handleListCategories(args, categories);
        break;
      case 'analizar_finanzas':
        result = await handleAnalizarFinanzas(args, userId);
        break;
      default:
        result = { error: true, message: `Función no soportada: ${functionName}` };
    }
  } catch (error: any) {
    logger.error(`[ZenioAgents] Error ejecutando ${functionName}:`, error);
    result = { success: false, error: error.message || 'Error desconocido' };
  }

  return { toolCallId: call.call_id, result, action: result?.action };
}

// --- Transaction handler ---
async function handleTransaction(args: any, userId: string, categories?: any[], timezone?: string): Promise<any> {
  const { operation, transaction_data, criterios_identificacion, filtros_busqueda } = args;
  if (!operation) throw new Error('Operación requerida');

  switch (operation) {
    case 'insert': {
      if (!transaction_data) throw new Error('Datos de transacción requeridos');
      const type = transaction_data.type === 'gasto' ? 'EXPENSE' : 'INCOME';
      const amount = parseFloat(transaction_data.amount);
      if (!amount || amount <= 0) throw new Error('Monto debe ser mayor a 0');

      const cv = await validateCategory(transaction_data.category, transaction_data.type, categories);
      if (!cv.valid) return { success: false, message: `Categoría no encontrada: "${transaction_data.category}". Disponibles: ${cv.suggestions?.join(', ')}` };

      const ahora = new Date();
      const offsetRD = -4;
      const utc = ahora.getTime() + (ahora.getTimezoneOffset() * 60000);
      const fechaRD = new Date(utc + (offsetRD * 60 * 60 * 1000));
      let date = fechaRD;
      if (transaction_data.date) {
        const parsed = new Date(transaction_data.date + 'T00:00:00');
        if (!isNaN(parsed.getTime())) date = parsed;
      }

      const tx = await prisma.transaction.create({
        data: {
          userId, type, amount, category_id: cv.categoryId!,
          description: transaction_data.description || '', date,
        },
        include: { category: { select: { id: true, name: true, icon: true, type: true } } },
      });

      // Recalcular presupuesto
      if (type === 'EXPENSE') {
        try { await recalculateBudgetSpent(userId, cv.categoryId!, tx.date); } catch {}
      }

      return { success: true, message: `Transacción registrada: ${tx.category.name} por RD$${amount.toLocaleString('es-DO')}`, transaction: tx, action: 'transaction_created' };
    }
    case 'list': {
      const where: any = { user_id: userId };
      if (filtros_busqueda?.type) where.type = filtros_busqueda.type === 'gasto' ? 'EXPENSE' : 'INCOME';
      if (filtros_busqueda?.category) {
        const cat = await prisma.category.findFirst({ where: { name: { equals: filtros_busqueda.category, mode: 'insensitive' } } });
        if (cat) where.category_id = cat.id;
      }
      if (filtros_busqueda?.date_from) where.date = { ...where.date, gte: new Date(filtros_busqueda.date_from) };
      if (filtros_busqueda?.date_to) where.date = { ...where.date, lte: new Date(filtros_busqueda.date_to) };
      if (filtros_busqueda?.date) where.date = { gte: new Date(filtros_busqueda.date + 'T00:00:00'), lte: new Date(filtros_busqueda.date + 'T23:59:59') };

      const transactions = await prisma.transaction.findMany({
        where, orderBy: { date: 'desc' }, take: filtros_busqueda?.limit || 10,
        include: { category: { select: { name: true, icon: true, type: true } } },
      });
      return { success: true, transactions, count: transactions.length, action: 'transactions_listed' };
    }
    case 'update': {
      if (!transaction_data) throw new Error('Datos de transacción requeridos');
      if (!criterios_identificacion) throw new Error('Criterios de identificación requeridos para update');

      const where: any = { userId };
      if (criterios_identificacion.amount) where.amount = parseFloat(criterios_identificacion.amount);
      if (criterios_identificacion.type) where.type = criterios_identificacion.type === 'gasto' ? 'EXPENSE' : 'INCOME';
      if (criterios_identificacion.category) {
        const cat = await prisma.category.findFirst({ where: { name: { equals: criterios_identificacion.category, mode: 'insensitive' } } });
        if (cat) where.category_id = cat.id;
      }
      if (criterios_identificacion.date) where.date = { gte: new Date(criterios_identificacion.date + 'T00:00:00'), lte: new Date(criterios_identificacion.date + 'T23:59:59') };

      const candidates = await prisma.transaction.findMany({ where, include: { category: { select: { id: true, name: true, icon: true, type: true } } } });
      if (candidates.length === 0) return { success: false, message: 'No se encontró la transacción con esos criterios.' };
      if (candidates.length > 1) return { success: false, message: `Se encontraron ${candidates.length} transacciones. Especifica más criterios.` };

      const updateData: any = {};
      if (transaction_data.amount) updateData.amount = parseFloat(transaction_data.amount);
      if (transaction_data.type) updateData.type = transaction_data.type === 'gasto' ? 'EXPENSE' : 'INCOME';
      if (transaction_data.category) {
        const cv = await validateCategory(transaction_data.category, transaction_data.type || 'gasto', categories);
        if (cv.valid) updateData.category_id = cv.categoryId;
      }
      if (transaction_data.description) updateData.description = transaction_data.description;
      if (transaction_data.date) updateData.date = new Date(transaction_data.date + 'T00:00:00');

      const updated = await prisma.transaction.update({ where: { id: candidates[0].id }, data: updateData, include: { category: { select: { id: true, name: true, icon: true, type: true } } } });
      return { success: true, message: 'Transacción actualizada.', transaction: updated, action: 'transaction_updated' };
    }
    case 'delete': {
      if (!criterios_identificacion) throw new Error('Criterios de identificación requeridos para delete');

      const where: any = { userId };
      if (criterios_identificacion.amount) where.amount = parseFloat(criterios_identificacion.amount);
      if (criterios_identificacion.type) where.type = criterios_identificacion.type === 'gasto' ? 'EXPENSE' : 'INCOME';
      if (criterios_identificacion.category) {
        const cat = await prisma.category.findFirst({ where: { name: { equals: criterios_identificacion.category, mode: 'insensitive' } } });
        if (cat) where.category_id = cat.id;
      }
      if (criterios_identificacion.date) where.date = { gte: new Date(criterios_identificacion.date + 'T00:00:00'), lte: new Date(criterios_identificacion.date + 'T23:59:59') };

      const candidates = await prisma.transaction.findMany({ where });
      if (candidates.length === 0) return { success: false, message: 'No se encontró la transacción con esos criterios.' };
      if (candidates.length > 1) return { success: false, message: `Se encontraron ${candidates.length} transacciones. Especifica más criterios.` };

      await prisma.transaction.delete({ where: { id: candidates[0].id } });

      // Recalcular presupuesto si era gasto
      if (candidates[0].type === 'EXPENSE') {
        try { await recalculateBudgetSpent(userId, candidates[0].category_id, candidates[0].date); } catch {}
      }

      return { success: true, message: 'Transacción eliminada.', action: 'transaction_deleted' };
    }
    default:
      throw new Error(`Operación de transacción no soportada: ${operation}`);
  }
}

// --- Budget handler ---
async function handleBudget(args: any, userId: string, categories?: any[]): Promise<any> {
  const { operation, category, amount, recurrence, filtros_busqueda } = args;
  if (!operation) throw new Error('Operación requerida');

  switch (operation) {
    case 'insert': {
      if (!category) throw new Error('Categoría requerida');
      if (!amount) throw new Error('Monto requerido');

      // Check limit
      const subscription = await prisma.subscription.findUnique({ where: { userId } });
      const BUDGET_LIMITS: Record<string, number> = { FREE: 4, PREMIUM: -1, PRO: -1 };
      const plan = subscription?.plan || 'FREE';
      const budgetLimit = BUDGET_LIMITS[plan] || 4;
      if (budgetLimit !== -1) {
        const count = await prisma.budget.count({ where: { user_id: userId, is_active: true } });
        if (count >= budgetLimit) return { success: false, message: `Límite de presupuestos alcanzado (${count}/${budgetLimit}).`, upgrade: true };
      }

      const cv = await validateCategory(category, 'gasto', categories);
      if (!cv.valid) return { success: false, message: `Categoría no encontrada: "${category}". Disponibles: ${cv.suggestions?.join(', ')}` };

      const periodMap: Record<string, string> = { 'semanal': 'weekly', 'mensual': 'monthly', 'anual': 'yearly' };
      const period = periodMap[recurrence] || 'monthly';
      const now = new Date();
      let startDate: Date, endDate: Date;

      if (recurrence === 'semanal') {
        const day = now.getDay(); const diff = (day === 0 ? -6 : 1) - day;
        startDate = new Date(now); startDate.setDate(now.getDate() + diff); startDate.setHours(0, 0, 0, 0);
        endDate = new Date(startDate); endDate.setDate(startDate.getDate() + 6); endDate.setHours(23, 59, 59, 999);
      } else if (recurrence === 'anual') {
        startDate = new Date(now.getFullYear(), 0, 1); endDate = new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999);
      } else {
        startDate = new Date(now.getFullYear(), now.getMonth(), 1);
        endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
      }

      const budget = await prisma.budget.create({
        data: { user_id: userId, name: category, category_id: cv.categoryId!, amount: parseFloat(amount), period, start_date: startDate, end_date: endDate, alert_percentage: 80 },
        include: { category: { select: { id: true, name: true, icon: true, type: true } } },
      });
      return { success: true, message: `Presupuesto creado: ${budget.category.name} por RD$${parseFloat(amount).toLocaleString('es-DO')} (${recurrence || 'mensual'})`, budget, action: 'budget_created' };
    }
    case 'list': {
      const where: any = { user_id: userId, is_active: true };
      const budgets = await prisma.budget.findMany({
        where, orderBy: { created_at: 'desc' }, take: filtros_busqueda?.limit || 10,
        include: { category: { select: { name: true, icon: true, type: true } } },
      });
      return { success: true, budgets, count: budgets.length, action: 'budgets_listed' };
    }
    case 'update': {
      if (!category) throw new Error('Categoría requerida para update');
      const { previous_amount } = args;
      if (!previous_amount || !amount) throw new Error('Monto anterior y nuevo monto requeridos');

      const where: any = { user_id: userId, is_active: true, amount: parseFloat(previous_amount) };
      const cat = await prisma.category.findFirst({ where: { name: { equals: category, mode: 'insensitive' } } });
      if (cat) where.category_id = cat.id;
      else {
        const all = await prisma.category.findMany();
        const found = all.find(c => normalizarTexto(c.name) === normalizarTexto(category));
        if (found) where.category_id = found.id;
      }

      const candidates = await prisma.budget.findMany({ where, include: { category: { select: { id: true, name: true, icon: true, type: true } } } });
      if (candidates.length === 0) return { success: false, message: 'No se encontró el presupuesto.' };
      if (candidates.length > 1) return { success: false, message: 'Se encontraron varios presupuestos. Especifica más.' };

      const updated = await prisma.budget.update({ where: { id: candidates[0].id }, data: { amount: parseFloat(amount) }, include: { category: { select: { id: true, name: true, icon: true, type: true } } } });
      return { success: true, message: 'Presupuesto actualizado.', budget: updated, action: 'budget_updated' };
    }
    case 'delete': {
      if (!category) throw new Error('Categoría requerida para delete');
      const { previous_amount: prevAmt } = args;

      const where: any = { user_id: userId, is_active: true };
      if (prevAmt) where.amount = parseFloat(prevAmt);
      const cat2 = await prisma.category.findFirst({ where: { name: { equals: category, mode: 'insensitive' } } });
      if (cat2) where.category_id = cat2.id;

      const candidates = await prisma.budget.findMany({ where });
      if (candidates.length === 0) return { success: false, message: 'No se encontró el presupuesto.' };
      if (candidates.length > 1) return { success: false, message: 'Se encontraron varios presupuestos. Especifica más.' };

      await prisma.budget.update({ where: { id: candidates[0].id }, data: { is_active: false } });
      return { success: true, message: 'Presupuesto eliminado.', action: 'budget_deleted' };
    }
    default:
      throw new Error(`Operación de presupuesto no soportada: ${operation}`);
  }
}

// --- Goal handler ---
async function handleGoal(args: any, userId: string, categories?: any[]): Promise<any> {
  const { operation, goal_data, filtros_busqueda } = args;
  if (!operation) throw new Error('Operación requerida');

  switch (operation) {
    case 'insert': {
      if (!goal_data) throw new Error('Datos de meta requeridos');

      // Check limit
      const subscription = await prisma.subscription.findUnique({ where: { userId } });
      const GOAL_LIMITS: Record<string, number> = { FREE: 2, PREMIUM: -1, PRO: -1 };
      const plan = subscription?.plan || 'FREE';
      const goalLimit = GOAL_LIMITS[plan] || 2;
      if (goalLimit !== -1) {
        const count = await prisma.goal.count({ where: { userId, isActive: true, isCompleted: false } });
        if (count >= goalLimit) return { success: false, message: `Límite de metas alcanzado (${count}/${goalLimit}).`, upgrade: true };
      }

      const cv = await validateCategory(goal_data.category || 'Otros gastos', 'gasto', categories);
      if (!cv.valid) return { success: false, message: `Categoría no encontrada. Disponibles: ${cv.suggestions?.join(', ')}` };

      const monthlyValue = parseFloat(goal_data.monthly_value || '0');
      const goal = await prisma.goal.create({
        data: {
          userId, name: goal_data.name || 'Meta de ahorro',
          targetAmount: parseFloat(goal_data.target_amount || '0'),
          categoryId: cv.categoryId!,
          targetDate: goal_data.due_date ? new Date(goal_data.due_date) : null,
          monthlyTargetPercentage: goal_data.monthly_type === 'porcentaje' ? monthlyValue : null,
          monthlyContributionAmount: goal_data.monthly_type !== 'porcentaje' ? monthlyValue : null,
          priority: (goal_data.priority || 'medium').toLowerCase(),
          description: goal_data.description || '',
        },
        include: { category: { select: { id: true, name: true, icon: true, type: true } } },
      });
      return { success: true, message: `Meta creada: ${goal.name} por RD$${goal.targetAmount.toLocaleString('es-DO')}`, goal, action: 'goal_created' };
    }
    case 'list': {
      const goals = await prisma.goal.findMany({
        where: { userId, isActive: true, isCompleted: false }, orderBy: { createdAt: 'desc' }, take: filtros_busqueda?.limit || 10,
        include: { category: { select: { name: true, icon: true, type: true } } },
      });
      return { success: true, goals, count: goals.length, action: 'goals_listed' };
    }
    case 'update': {
      if (!goal_data) throw new Error('Datos de meta requeridos para update');
      const { criterios_identificacion } = args;
      if (!criterios_identificacion) throw new Error('Criterios de identificación requeridos para update');

      const where: any = { userId, isActive: true, isCompleted: false };
      if (criterios_identificacion.name) where.name = { contains: criterios_identificacion.name, mode: 'insensitive' };
      if (criterios_identificacion.target_amount) where.targetAmount = parseFloat(criterios_identificacion.target_amount);
      if (criterios_identificacion.category) {
        const cat = await prisma.category.findFirst({ where: { name: { equals: criterios_identificacion.category, mode: 'insensitive' } } });
        if (cat) where.categoryId = cat.id;
      }

      const candidates = await prisma.goal.findMany({ where, include: { category: { select: { id: true, name: true, icon: true, type: true } } } });
      if (candidates.length === 0) return { success: false, message: 'No se encontró la meta con esos criterios.' };
      if (candidates.length > 1) return { success: false, message: `Se encontraron ${candidates.length} metas. Especifica más criterios.` };

      const updateData: any = {};
      if (goal_data.name) updateData.name = goal_data.name;
      if (goal_data.target_amount) updateData.targetAmount = parseFloat(goal_data.target_amount);
      if (goal_data.due_date) updateData.targetDate = new Date(goal_data.due_date);
      if (goal_data.description) updateData.description = goal_data.description;
      if (goal_data.priority) updateData.priority = goal_data.priority.toLowerCase();
      if (goal_data.category) {
        const cv = await validateCategory(goal_data.category, 'gasto', categories);
        if (cv.valid) updateData.categoryId = cv.categoryId;
      }
      if (goal_data.monthly_value) {
        const mv = parseFloat(goal_data.monthly_value);
        if (goal_data.monthly_type === 'porcentaje') {
          updateData.monthlyTargetPercentage = mv;
          updateData.monthlyContributionAmount = null;
        } else {
          updateData.monthlyContributionAmount = mv;
          updateData.monthlyTargetPercentage = null;
        }
      }

      const updated = await prisma.goal.update({ where: { id: candidates[0].id }, data: updateData, include: { category: { select: { id: true, name: true, icon: true, type: true } } } });
      return { success: true, message: 'Meta actualizada.', goal: updated, action: 'goal_updated' };
    }
    case 'delete': {
      const { criterios_identificacion } = args;
      if (!criterios_identificacion) throw new Error('Criterios de identificación requeridos para delete');

      const where: any = { userId, isActive: true, isCompleted: false };
      if (criterios_identificacion.name) where.name = { contains: criterios_identificacion.name, mode: 'insensitive' };
      if (criterios_identificacion.target_amount) where.targetAmount = parseFloat(criterios_identificacion.target_amount);
      if (criterios_identificacion.category) {
        const cat = await prisma.category.findFirst({ where: { name: { equals: criterios_identificacion.category, mode: 'insensitive' } } });
        if (cat) where.categoryId = cat.id;
      }

      const candidates = await prisma.goal.findMany({ where });
      if (candidates.length === 0) return { success: false, message: 'No se encontró la meta con esos criterios.' };
      if (candidates.length > 1) return { success: false, message: `Se encontraron ${candidates.length} metas. Especifica más criterios.` };

      await prisma.goal.update({ where: { id: candidates[0].id }, data: { isActive: false } });
      return { success: true, message: 'Meta eliminada.', action: 'goal_deleted' };
    }
    default:
      throw new Error(`Operación de meta no soportada: ${operation}`);
  }
}

// --- List categories handler ---
async function handleListCategories(args: any, categories?: any[]): Promise<any> {
  const { module } = args;
  if (!categories || categories.length === 0) {
    try {
      categories = await prisma.category.findMany({ select: { id: true, name: true, type: true } });
    } catch {
      return { error: true, message: 'Error al obtener categorías' };
    }
  }

  let filtered: any[] = [];
  switch (module) {
    case 'presupuestos': filtered = categories!.filter((c: any) => c.type === 'EXPENSE'); break;
    case 'transacciones': case 'metas': filtered = categories!; break;
    default: return { error: true, message: `Módulo no válido: ${module}` };
  }
  return { categories: filtered.map((c: any) => c.name), count: filtered.length, module };
}

// --- Analizar finanzas handler (ANALISTA) ---
async function handleAnalizarFinanzas(args: any, userId: string): Promise<any> {
  const periodo = args?.periodo || 'ambos';

  const ahora = new Date();
  const offsetRD = -4;
  const utc = ahora.getTime() + (ahora.getTimezoneOffset() * 60000);
  const fechaRD = new Date(utc + (offsetRD * 60 * 60 * 1000));

  const mesActualInicio = new Date(fechaRD.getFullYear(), fechaRD.getMonth(), 1);
  const mesActualFin = new Date(fechaRD.getFullYear(), fechaRD.getMonth() + 1, 0, 23, 59, 59, 999);
  const mesAnteriorInicio = new Date(fechaRD.getFullYear(), fechaRD.getMonth() - 1, 1);
  const mesAnteriorFin = new Date(fechaRD.getFullYear(), fechaRD.getMonth(), 0, 23, 59, 59, 999);

  // 1. Transacciones
  let transaccionesMesActual: any[] = [];
  let transaccionesMesAnterior: any[] = [];

  if (periodo === 'mes_actual' || periodo === 'ambos') {
    transaccionesMesActual = await prisma.transaction.findMany({
      where: { userId, date: { gte: mesActualInicio, lte: mesActualFin } },
      include: { category: { select: { name: true, type: true } } },
      orderBy: { date: 'desc' },
    });
  }
  if (periodo === 'mes_anterior' || periodo === 'ambos') {
    transaccionesMesAnterior = await prisma.transaction.findMany({
      where: { userId, date: { gte: mesAnteriorInicio, lte: mesAnteriorFin } },
      include: { category: { select: { name: true, type: true } } },
      orderBy: { date: 'desc' },
    });
  }

  // 2. Resumen de gastos por categoría
  const resumenGastosMesActual: Record<string, number> = {};
  let totalGastosMesActual = 0;
  let totalIngresosMesActual = 0;
  for (const tx of transaccionesMesActual) {
    if (tx.type === 'EXPENSE') {
      const cat = tx.category?.name || 'Sin categoría';
      resumenGastosMesActual[cat] = (resumenGastosMesActual[cat] || 0) + tx.amount;
      totalGastosMesActual += tx.amount;
    } else {
      totalIngresosMesActual += tx.amount;
    }
  }

  const resumenGastosMesAnterior: Record<string, number> = {};
  let totalGastosMesAnterior = 0;
  let totalIngresosMesAnterior = 0;
  for (const tx of transaccionesMesAnterior) {
    if (tx.type === 'EXPENSE') {
      const cat = tx.category?.name || 'Sin categoría';
      resumenGastosMesAnterior[cat] = (resumenGastosMesAnterior[cat] || 0) + tx.amount;
      totalGastosMesAnterior += tx.amount;
    } else {
      totalIngresosMesAnterior += tx.amount;
    }
  }

  // Top 3 categorías de gasto
  const topCategorias = Object.entries(resumenGastosMesActual)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([cat, monto]) => ({ categoria: cat, monto, porcentaje: totalGastosMesActual > 0 ? Math.round((monto / totalGastosMesActual) * 100) : 0 }));

  // 3. Presupuestos activos
  const presupuestos = await prisma.budget.findMany({
    where: { user_id: userId, is_active: true },
    include: { category: { select: { name: true, icon: true } } },
  });

  const presupuestosResumen = presupuestos.map(b => ({
    categoria: b.category.name,
    asignado: b.amount,
    gastado: b.spent,
    porcentajeUso: b.amount > 0 ? Math.round((b.spent / b.amount) * 100) : 0,
    estado: b.amount > 0 ? (b.spent / b.amount >= 0.9 ? 'ROJO' : b.spent / b.amount >= 0.7 ? 'AMARILLO' : 'VERDE') : 'VERDE',
    restante: b.amount - b.spent,
  }));

  // 4. Metas activas
  const metas = await prisma.goal.findMany({
    where: { userId, isActive: true, isCompleted: false },
    include: { category: { select: { name: true } } },
  });

  const metasResumen = metas.map(g => {
    const progreso = g.targetAmount > 0 ? Math.round((g.currentAmount / g.targetAmount) * 100) : 0;
    let diasRestantes = null;
    let tiempoPorcentaje = null;
    if (g.targetDate) {
      const hoy = fechaRD;
      const inicio = g.createdAt;
      const fin = g.targetDate;
      const totalDias = Math.max(1, Math.ceil((fin.getTime() - inicio.getTime()) / (1000 * 60 * 60 * 24)));
      const diasTranscurridos = Math.ceil((hoy.getTime() - inicio.getTime()) / (1000 * 60 * 60 * 24));
      diasRestantes = Math.max(0, totalDias - diasTranscurridos);
      tiempoPorcentaje = Math.round((diasTranscurridos / totalDias) * 100);
    }
    return {
      nombre: g.name,
      montoObjetivo: g.targetAmount,
      montoActual: g.currentAmount,
      progreso,
      fechaLimite: g.targetDate ? g.targetDate.toISOString().split('T')[0] : null,
      diasRestantes,
      tiempoPorcentaje,
      vaAlDia: tiempoPorcentaje ? progreso >= tiempoPorcentaje : null,
      aportesMensuales: g.monthlyContributionAmount,
    };
  });

  // 5. Perfil de onboarding
  let onboarding = null;
  try {
    onboarding = await prisma.onboarding.findUnique({ where: { userId } });
  } catch {}

  const perfilOnboarding = onboarding ? {
    metaPrincipal: onboarding.mainGoals,
    desafio: onboarding.mainChallenge,
    fondoEmergencia: onboarding.emergencyFund,
    sentimiento: onboarding.financialFeeling,
    rangoIngresos: onboarding.incomeRange,
  } : null;

  // 6. Días restantes del mes
  const diasEnMes = new Date(fechaRD.getFullYear(), fechaRD.getMonth() + 1, 0).getDate();
  const diaActual = fechaRD.getDate();
  const diasRestantesMes = diasEnMes - diaActual;

  return {
    success: true,
    snapshot: {
      fecha: fechaRD.toISOString().split('T')[0],
      diaActual,
      diasRestantesMes,
      mesActual: {
        totalGastos: totalGastosMesActual,
        totalIngresos: totalIngresosMesActual,
        balance: totalIngresosMesActual - totalGastosMesActual,
        transacciones: transaccionesMesActual.length,
        topCategorias,
        gastosPorCategoria: resumenGastosMesActual,
      },
      mesAnterior: periodo === 'ambos' || periodo === 'mes_anterior' ? {
        totalGastos: totalGastosMesAnterior,
        totalIngresos: totalIngresosMesAnterior,
        balance: totalIngresosMesAnterior - totalGastosMesAnterior,
        transacciones: transaccionesMesAnterior.length,
        gastosPorCategoria: resumenGastosMesAnterior,
      } : null,
      presupuestos: presupuestosResumen,
      metas: metasResumen,
      perfilOnboarding,
    },
    action: 'finanzas_analizadas',
  };
}

// =============================================
// CONTROLADOR PRINCIPAL — AGENTES
// =============================================

export const chatWithZenioAgents = async (req: Request, res: Response) => {
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
    } catch (e) { logger.error('[ZenioAgents] Error obteniendo usuario:', e); }

    // 3. Validar límite de consultas Zenio
    const ZENIO_LIMITS: Record<string, number> = { FREE: 15, PREMIUM: -1, PRO: -1 };
    let subscription = await prisma.subscription.findUnique({ where: { userId } });
    if (!subscription) {
      subscription = await prisma.subscription.create({
        data: { userId, plan: 'FREE', status: 'ACTIVE', zenioQueriesUsed: 0, zenioQueriesResetAt: new Date() },
      });
    }

    // Reseteo mensual
    const now = new Date();
    const resetDate = subscription.zenioQueriesResetAt;
    if (!resetDate || now.getMonth() !== resetDate.getMonth() || now.getFullYear() !== resetDate.getFullYear()) {
      subscription = await prisma.subscription.update({ where: { userId }, data: { zenioQueriesUsed: 0, zenioQueriesResetAt: now } });
    }

    const zenioLimit = ZENIO_LIMITS[subscription.plan] || 15;
    const currentCount = subscription.zenioQueriesUsed || 0;
    if (zenioLimit !== -1 && currentCount >= zenioLimit) {
      return res.status(403).json({ success: false, error: 'ZENIO_LIMIT_REACHED', message: 'Has alcanzado el límite de consultas de Zenio.', upgrade: true });
    }

    // 4. Obtener datos del request
    let { message, threadId: incomingThreadId, isOnboarding, categories, timezone, autoGreeting } = req.body;
    const userTimezone = timezone || 'UTC';

    if (!categories || categories.length === 0) {
      try { categories = await prisma.category.findMany({ select: { id: true, name: true, type: true } }); } catch { categories = []; }
    }

    if (typeof message === 'string') {
      message = reemplazarExpresionesTemporalesPorFecha(message);
    }

    // 5. ROUTER — Clasificar intención
    const agentType: AgentType = classifyIntent(message || '');
    logger.log(`[ZenioAgents] Router → ${agentType} | Mensaje: "${(message || '').substring(0, 80)}"`);

    // 6. Seleccionar prompt y tools según agente
    const agentPromptMap: Record<AgentType, string> = {
      asistente: ZENIO_ASISTENTE_PROMPT,
      educativo: ZENIO_EDUCATIVO_PROMPT,
      analista: ZENIO_ANALISTA_PROMPT,
    };
    const agentToolsMap: Record<AgentType, any[]> = {
      asistente: ASISTENTE_TOOLS,
      educativo: EDUCATIVO_TOOLS,
      analista: ANALISTA_TOOLS,
    };
    const agentPrompt = agentPromptMap[agentType];
    const agentTools = agentToolsMap[agentType];

    // 7. Construir contexto dinámico
    const ahora = new Date();
    const offsetRD = -4;
    const utc = ahora.getTime() + (ahora.getTimezoneOffset() * 60000);
    const fechaRD = new Date(utc + (offsetRD * 60 * 60 * 1000));
    const fechaActual = fechaRD.toISOString().split('T')[0];
    const fechaHumana = fechaRD.toLocaleDateString('es-ES', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

    let categoriesContext = '';
    if (categories && categories.length > 0) {
      const expense = categories.filter((c: any) => c.type === 'EXPENSE').map((c: any) => c.name);
      const income = categories.filter((c: any) => c.type === 'INCOME').map((c: any) => c.name);
      categoriesContext = `\n\nCATEGORÍAS DISPONIBLES EN LA APP:\n- Gastos: ${expense.join(', ')}\n- Ingresos: ${income.join(', ')}\nUSA SOLO estas categorías. NUNCA inventes categorías que no estén en esta lista.`;
    }

    const dateContext = `\n\nFECHA ACTUAL: Hoy es ${fechaHumana} (${fechaActual}). Año ${fechaRD.getFullYear()}. Zona horaria: República Dominicana (UTC-4).`;
    const dynamicInstructions = `${agentPrompt}${dateContext}${categoriesContext}`;

    // 8. Construir input
    const input: any[] = [];
    const isFirstMessage = !incomingThreadId || typeof incomingThreadId !== 'string';

    if (isFirstMessage) {
      input.push({ role: 'user', content: `El usuario se llama ${userName}. Siempre que lo saludes, hazlo de forma natural y menciona su nombre.` });
      input.push({ role: 'assistant', content: `Entendido, el usuario se llama ${userName}. Lo saludaré por su nombre de forma natural.` });
    }

    if (message) {
      input.push({ role: 'user', content: message });
    }

    // 9. Llamar a OpenAI Responses API
    const previousResponseId = isFirstMessage ? undefined : incomingThreadId;

    let response = await openai.responses.create({
      model: ZENIO_MODEL,
      instructions: dynamicInstructions,
      input,
      tools: agentTools,
      temperature: ZENIO_TEMPERATURE,
      previous_response_id: previousResponseId,
      store: true,
    });

    let lastKnownResponseId = response.id;

    // 10. Loop de tool calls (solo para Asistente)
    let executedActions: any[] = [];
    let toolCallIterations = 0;
    const maxToolCallIterations = 10;

    while (toolCallIterations < maxToolCallIterations) {
      const functionCalls = response.output.filter((item: any) => item.type === 'function_call');
      if (functionCalls.length === 0) break;

      toolCallIterations++;
      logger.log(`[ZenioAgents] Tool call iteración ${toolCallIterations}, ${functionCalls.length} calls (agente: ${agentType})`);

      const toolResults = [];
      for (const call of functionCalls) {
        const result = await handleToolCall(call, userId, userName, categories, userTimezone);
        toolResults.push(result);
        if (result.action) executedActions.push({ action: result.action, data: result.result });
      }

      const toolOutputs = toolResults.map(tr => ({
        type: 'function_call_output' as const,
        call_id: tr.toolCallId,
        output: JSON.stringify(tr.result),
      }));

      try {
        response = await openai.responses.create({
          model: ZENIO_MODEL,
          instructions: dynamicInstructions,
          input: toolOutputs,
          tools: agentTools,
          temperature: ZENIO_TEMPERATURE,
          previous_response_id: response.id,
          store: true,
        });
        lastKnownResponseId = response.id;
      } catch (loopError: any) {
        logger.error(`[ZenioAgents] Error en loop de tool calls:`, loopError);
        if (executedActions.length > 0) {
          return res.json({
            message: 'Se ejecutaron las acciones pero hubo un problema al generar la respuesta.',
            threadId: lastKnownResponseId,
            agentType,
            executedActions,
          });
        }
        throw loopError;
      }
    }

    // 11. Obtener respuesta final
    const assistantResponse = response.output_text || 'No se pudo obtener respuesta.';

    // 12. Incrementar contador
    let zenioUsage = { used: 0, limit: 15, remaining: 15 };
    try {
      if (!autoGreeting && !isOnboarding) {
        const updatedSub = await prisma.subscription.update({ where: { userId }, data: { zenioQueriesUsed: { increment: 1 } } });
        const limit = zenioLimit;
        zenioUsage = { used: updatedSub.zenioQueriesUsed, limit, remaining: limit === -1 ? -1 : Math.max(0, limit - updatedSub.zenioQueriesUsed) };
      }
    } catch (e) { logger.error('[ZenioAgents] Error actualizando contador:', e); }

    // 13. Responder
    const responsePayload: any = {
      message: assistantResponse,
      threadId: response.id,
      agentType,
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
    logger.error('[ZenioAgents] Error:', error);
    const errorThreadId = req.body?.threadId;

    if (error?.status === 401) return res.status(401).json({ message: 'Error de autenticación con OpenAI.', threadId: errorThreadId });
    if (error?.status === 429) return res.status(429).json({ message: 'Zenio está procesando muchos mensajes. Espera un momento.', threadId: errorThreadId });
    if (error?.status === 400) {
      const isConvError = error.message?.includes('previous_response_id');
      return res.status(400).json({ message: isConvError ? 'La conversación expiró. Inicia una nueva.' : 'Request inválida.', error: isConvError ? 'CONVERSATION_EXPIRED' : 'BAD_REQUEST', threadId: isConvError ? undefined : errorThreadId });
    }
    return res.status(500).json({ error: 'Error al comunicarse con Zenio.', message: error.message, threadId: errorThreadId });
  }
};
