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
import { stripFileCitations } from '../utils/stripFileCitations';
import { onValidTransaction as onValidTransactionH13 } from '../services/h13/h13Service';
import { ZENIO_MODEL, ZENIO_TEMPERATURE } from '../config/zenioPrompt';
import { OpenAiUsageService } from '../services/openAiUsageService';
import { calculateOpenAICost } from '../config/openaiPricing';
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
import { recalculateBudgets } from '../services/budgetService';

import { crearPresupuestoSinSolapar, buscarPresupuestoSolapado, PresupuestoSolapadoError } from '../services/budgetService';
import { validarCategoria } from '../utils/validarCategoria';
// =============================================
// FUNCIONES DE UTILIDAD (replicadas de zenioV2.ts)
// =============================================

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

async function validateCategory(categoryName: string, expectedType: string, categories?: any[]): Promise<{ valid: boolean; error?: string; categoryId?: string; suggestions?: string[] }> {
  // Implementación única en utils/validarCategoria.ts. Antes había tres copias
  // divergentes: solo una hacía coincidencia parcial, así que "presupuesto de
  // salario" funcionaba en el chat y fallaba en el onboarding con el mismo texto.
  return validarCategoria(categoryName, expectedType, categories);
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


/**
 * Ventana de calendario que le corresponde a una recurrencia, en el momento
 * actual. Estaba escrito dentro del insert; se saca aparte para que el update
 * pueda cambiar de recurrencia sin duplicar la lógica.
 */
function ventanaDeRecurrencia(recurrence?: string): { period: string; startDate: Date; endDate: Date } {
  const periodMap: Record<string, string> = { 'semanal': 'weekly', 'quincenal': 'biweekly', 'mensual': 'monthly', 'anual': 'yearly' };
  const period = periodMap[recurrence || ''] || 'monthly';
  const now = new Date();
  let startDate: Date, endDate: Date;

  if (recurrence === 'semanal') {
    const day = now.getDay(); const diff = (day === 0 ? -6 : 1) - day;
    startDate = new Date(now); startDate.setDate(now.getDate() + diff); startDate.setHours(0, 0, 0, 0);
    endDate = new Date(startDate); endDate.setDate(startDate.getDate() + 6); endDate.setHours(23, 59, 59, 999);
  } else if (recurrence === 'quincenal') {
    // Quincena del CALENDARIO en curso: 1-15 o 16-fin de mes.
    if (now.getDate() <= 15) {
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      endDate = new Date(now.getFullYear(), now.getMonth(), 15, 23, 59, 59, 999);
    } else {
      startDate = new Date(now.getFullYear(), now.getMonth(), 16);
      endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    }
  } else if (recurrence === 'anual') {
    startDate = new Date(now.getFullYear(), 0, 1); endDate = new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999);
  } else {
    startDate = new Date(now.getFullYear(), now.getMonth(), 1);
    endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
  }

  return { period, startDate, endDate };
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

      // Recalcular presupuesto y notificar si cruza el umbral.
      // OJO: este camino llamaba al recálculo pero NUNCA a las alertas, así que
      // registrar un gasto por los agentes de Zenio actualizaba el presupuesto
      // sin avisar nunca. Con la llamada unificada eso ya no puede pasar.
      // Ingresos incluidos: ya existen presupuestos de INGRESO.
      try { await recalculateBudgets(userId, cv.categoryId!, tx.date, { notify: true }); } catch {}

      // H13 · Reto de la Primera Semana: asignar brazo en la 1ª TX válida. MISMO
      // hook que el controller REST — sin esto, los registros por Zenio (que el
      // reto incentiva) quedarían fuera del experimento. Devuelve el micro-insight
      // si el reto está en curso, para que Zenio lo incluya en su respuesta. Best-effort.
      let h13Insight: string | undefined;
      try { const r = await onValidTransactionH13(userId, tx.id); h13Insight = r?.insight; } catch {}

      const baseMsg = `Transacción registrada: ${tx.category.name} por RD$${amount.toLocaleString('es-DO')}`;
      return {
        success: true,
        message: h13Insight ? `${baseMsg}. ${h13Insight}` : baseMsg,
        transaction: tx,
        action: 'transaction_created',
      };
    }
    case 'list': {
      const where: any = { userId };
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
      if (!criterios_identificacion) return { success: false, message: 'Necesito saber cuál transacción actualizar (indica monto, categoría, fecha o tipo).' };

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

      const anterior = candidates[0];
      const updated = await prisma.transaction.update({ where: { id: anterior.id }, data: updateData, include: { category: { select: { id: true, name: true, icon: true, type: true } } } });

      // Editar por los agentes de Zenio no recalculaba nada: era el último hueco
      // de la familia. Dos llamadas porque la edición pudo mover la transacción
      // de categoría o de fecha (hay que descontarla de donde estaba y sumarla
      // donde quedó). Sin notificar: una corrección no es un movimiento nuevo.
      // Vale para presupuestos de gasto Y de ingreso; el servicio filtra por el
      // tipo que le toca a cada presupuesto.
      try {
        await recalculateBudgetSpent(userId, anterior.category_id, anterior.date);
        if (updated.category_id !== anterior.category_id || updated.date.getTime() !== anterior.date.getTime()) {
          await recalculateBudgetSpent(userId, updated.category_id, updated.date);
        }
      } catch {}

      return { success: true, message: 'Transacción actualizada.', transaction: updated, action: 'transaction_updated' };
    }
    case 'delete': {
      if (!criterios_identificacion) return { success: false, message: 'Necesito saber cuál transacción eliminar (indica monto, categoría, fecha o tipo).' };

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

      // Recalcular tras borrar. Sin notificar: bajar el acumulado no es un
      // movimiento nuevo del usuario. Ingresos incluidos.
      try { await recalculateBudgetSpent(userId, candidates[0].category_id, candidates[0].date); } catch {}

      return { success: true, message: 'Transacción eliminada.', action: 'transaction_deleted' };
    }
    default:
      throw new Error(`Operación de transacción no soportada: ${operation}`);
  }
}

// --- Budget handler ---
async function handleBudget(args: any, userId: string, categories?: any[]): Promise<any> {
  // `budget_type` decide si es un TECHO de gasto o una META de ingreso. Por
  // defecto 'gasto', que es el comportamiento histórico. La categoría tiene que
  // ser del mismo tipo: validateCategory lo exige, así que pedir un presupuesto
  // de gasto sobre "Salario" ahora falla limpio en vez de crear algo roto.
  const { operation, category, amount, recurrence, filtros_busqueda } = args;
  const tipoPedido: 'gasto' | 'ingreso' = args.budget_type === 'ingreso' ? 'ingreso' : 'gasto';
  const tipoBudget = tipoPedido === 'ingreso' ? 'INCOME' : 'EXPENSE';
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

      const cv = await validateCategory(category, tipoPedido, categories);
      if (!cv.valid) return { success: false, message: `Categoría no encontrada: "${category}". Disponibles: ${cv.suggestions?.join(', ')}` };

      const { period, startDate, endDate } = ventanaDeRecurrencia(recurrence);

      // Guardia contra solapamientos: Zenio creaba presupuestos SIN comprobar
      // nada, asi que por aqui se podia duplicar aunque el controlador REST lo
      // impidiera. Ver services/budgetService.ts.
      let budget;
      try {
        budget = await crearPresupuestoSinSolapar({
          user_id: userId, name: category, category_id: cv.categoryId!,
          amount: parseFloat(amount), period, start_date: startDate, end_date: endDate,
          alert_percentage: 80, type: tipoBudget,
          // La tool la anuncia ("se puede poner al crear") y se estaba
          // descartando en silencio.
          description: args.description?.trim() || null,
        });
      } catch (e: any) {
        if (e instanceof PresupuestoSolapadoError) {
          const y = e.existente;
          return { success: false, message: `Ya tienes un presupuesto de ${y.category?.name} activo en esas fechas, por RD$${Number(y.amount).toLocaleString('es-DO')}. Quieres que le cambie el monto en vez de crear otro?`, budget: y, action: 'budget_duplicate' };
        }
        throw e;
      }
      // Inicializar `spent` con lo que ya existe en el período: si no, el
      // presupuesto nace en 0 aunque el usuario lleve semanas registrando.
      try { await recalculateBudgetSpent(userId, cv.categoryId!, startDate); } catch {}

      return { success: true, message: `Presupuesto creado: ${budget.category.name} por RD$${parseFloat(amount).toLocaleString('es-DO')} (${recurrence || 'mensual'})`, budget, action: 'budget_created' };
    }
    case 'list': {
      const where: any = { user_id: userId, is_active: true };
      const budgets = await prisma.budget.findMany({
        where, orderBy: { created_at: 'desc' }, take: filtros_busqueda?.limit || 10,
        include: { category: { select: { name: true, icon: true, type: true } } },
      });
      // Se etiqueta por tipo antes de devolverlo al modelo, igual que en
      // `analizar_finanzas`. Devolver el registro crudo le pasaba a Zenio un
      // campo llamado `spent` (= "gastado") con lo que la persona lleva
      // COBRADO: "5.000 de 60.000" se lee como "gastaste poco, vas bien" cuando
      // significa "te faltan 55.000 por cobrar". La defensa no puede quedar
      // solo en el prompt.
      const etiqueta: Record<string, string> = {
        weekly: 'semanal', biweekly: 'quincenal', monthly: 'mensual', yearly: 'anual',
      };
      const budgetsEtiquetados = budgets.map((b: any) => {
        const monto = Number(b.amount) || 0;
        const acumulado = Number(b.spent) || 0;
        const pct = monto > 0 ? Math.round((acumulado / monto) * 100) : 0;
        const comun = {
          id: b.id,
          categoria: b.category?.name,
          icono: b.category?.icon,
          periodo: etiqueta[b.period] || b.period,
          descripcion: b.description || undefined,
          desde: b.start_date,
          hasta: b.end_date,
        };
        return b.type === 'INCOME'
          ? { ...comun, tipo: 'ingreso', meta: monto, recibido: acumulado,
              porcentajeAlcanzado: pct, falta: Math.max(0, monto - acumulado),
              nota: 'META de ingresos: `recibido` es lo COBRADO. Porcentaje bajo = va corto, no es bueno. Nunca digas "gastado" ni felicites por un porcentaje bajo.' }
          : { ...comun, tipo: 'gasto', asignado: monto, gastado: acumulado,
              porcentajeUso: pct, disponible: Math.max(0, monto - acumulado),
              nota: 'TECHO de gasto: porcentaje alto = alerta.' };
      });
      return { success: true, budgets: budgetsEtiquetados, count: budgets.length, action: 'budgets_listed' };
    }
    case 'update': {
      if (!category) throw new Error('Categoría requerida para update');
      const { previous_amount } = args;

      // Antes exigía monto anterior Y monto nuevo, y solo sabía cambiar el
      // monto. Si el usuario pedía "cámbiale la descripción" o "pásalo a
      // quincenal", Zenio no podía y encima fallaba con un error seco.
      const nuevaDescripcion = args.description;
      const quiereCambiarRecurrencia = !!recurrence;
      const quiereCambiarMonto = amount !== undefined && amount !== null && amount !== '';
      if (!quiereCambiarMonto && nuevaDescripcion === undefined && !quiereCambiarRecurrencia) {
        return { success: false, message: '¿Qué quieres cambiarle a ese presupuesto: el monto, la recurrencia o la descripción?' };
      }

      // La categoría se resuelve respetando el tipo pedido. Antes se buscaba por
      // nombre sin filtrar, así que con una categoría de ingreso y otra de gasto
      // con el mismo nombre se apuntaría al presupuesto equivocado.
      const where: any = { user_id: userId, is_active: true };
      if (previous_amount) where.amount = parseFloat(previous_amount);
      let cvU = await validateCategory(category, tipoPedido, categories);
      if (!cvU.valid) {
        // Al ACTUALIZAR no hay que ser estricto con el tipo: el presupuesto ya
        // existe y lleva el suyo. El modelo no siempre manda `budget_type`, y
        // sin este reintento "súbeme a 80 mil mi meta de salario" respondía
        // "categoría no encontrada" con una lista de categorías de gasto.
        const tipoContrario = tipoPedido === 'ingreso' ? 'gasto' : 'ingreso';
        cvU = await validateCategory(category, tipoContrario, categories);
      }
      if (!cvU.valid) return { success: false, message: `Categoría no encontrada: "${category}". Disponibles: ${cvU.suggestions?.join(', ')}` };
      where.category_id = cvU.categoryId;

      const candidates = await prisma.budget.findMany({ where, include: { category: { select: { id: true, name: true, icon: true, type: true } } } });
      if (candidates.length === 0) return { success: false, message: 'No se encontró el presupuesto.' };
      if (candidates.length > 1) return { success: false, message: `Tienes ${candidates.length} presupuestos de ${category}. ¿De cuál monto es el que quieres cambiar?` };

      const actual = candidates[0];
      const datos: any = {};
      const cambios: string[] = [];

      if (quiereCambiarMonto) {
        const monto = parseFloat(amount);
        if (!(monto > 0)) return { success: false, message: 'El monto debe ser mayor que cero.' };
        datos.amount = monto;
        cambios.push(`monto a RD$${monto.toLocaleString('es-DO')}`);
      }

      if (nuevaDescripcion !== undefined) {
        datos.description = String(nuevaDescripcion).trim() || null;
        cambios.push(datos.description ? 'la descripción' : 'quitada la descripción');
      }

      if (quiereCambiarRecurrencia) {
        const v = ventanaDeRecurrencia(recurrence);
        if (v.period !== actual.period) {
          // Cambiar de recurrencia mueve la ventana, así que puede chocar con
          // otro presupuesto activo de la misma categoría.
          const choque = await buscarPresupuestoSolapado(prisma, {
            user_id: userId,
            category_id: actual.category_id,
            start_date: v.startDate,
            end_date: v.endDate,
            excluirId: actual.id,
          });
          if (choque) {
            return { success: false, message: `No puedo pasarlo a ${recurrence}: chocaría con otro presupuesto de ${category} que ya tienes activo en esas fechas.`, action: 'budget_duplicate' };
          }
          datos.period = v.period;
          datos.start_date = v.startDate;
          datos.end_date = v.endDate;
          cambios.push(`recurrencia a ${recurrence}`);
        }
      }

      if (Object.keys(datos).length === 0) {
        return { success: true, message: 'Ese presupuesto ya estaba así, no hice ningún cambio.', budget: actual, action: 'budget_updated' };
      }

      const updated = await prisma.budget.update({
        where: { id: actual.id },
        data: datos,
        include: { category: { select: { id: true, name: true, icon: true, type: true } } },
      });

      // Si se movió la ventana, el acumulado del período anterior ya no aplica.
      if (datos.start_date) {
        await recalculateBudgets(userId, actual.category_id, datos.start_date, { notify: false });
      }

      const esMeta = updated.type === 'INCOME';
      return {
        success: true,
        message: `Listo, le cambié ${cambios.join(' y ')} a tu ${esMeta ? 'meta de ingresos' : 'presupuesto'} de ${updated.category.name}.`,
        budget: updated,
        action: 'budget_updated',
      };
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

      // El objetivo es obligatorio y tiene que ser positivo.
      //
      // Antes esto era `parseFloat(goal_data.target_amount || '0')`: si el
      // modelo no extraía el monto, la meta se creaba igualmente con objetivo 0.
      // Es la puerta por la que entraron las 10 metas sin objetivo que hay en
      // producción, y a esas personas el recordatorio semanal les llegaba
      // diciendo «Tu meta está al NaN%. Faltan DOP0.00 para completarla».
      // Los otros dos caminos de Zenio sí validaban; este, que es el que usan
      // las apps, no.
      const objetivo = parseFloat(goal_data.target_amount);
      if (!(objetivo > 0)) {
        return {
          success: false,
          message: `¿De cuánto quieres que sea la meta de "${goal_data.name || 'ahorro'}"? Necesito el monto para poder seguir tu avance.`,
          action: 'goal_missing_amount',
        };
      }

      const monthlyValue = parseFloat(goal_data.monthly_value || '0');
      const goal = await prisma.goal.create({
        data: {
          userId, name: goal_data.name || 'Meta de ahorro',
          targetAmount: objetivo,
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
      if (!criterios_identificacion) return { success: false, message: 'Necesito saber cuál meta actualizar (indica su nombre).' };

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
      if (!criterios_identificacion) return { success: false, message: 'Necesito saber cuál meta eliminar (indica su nombre).' };

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
    // Antes filtraba solo EXPENSE. Ya existen presupuestos de INGRESO, así que
    // ese filtro escondía las categorías necesarias para crearlos.
    case 'presupuestos': filtered = categories!; break;
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

  // 3. Presupuestos activos, SOLO los que están vigentes hoy.
  //
  // Antes se traían todos los `is_active` sin mirar la ventana, así que se
  // colaban quincenas ya cerradas junto a la actual y Zenio las comentaba como
  // si siguieran corriendo.
  const ahoraParaPresupuestos = new Date();
  const presupuestos = await prisma.budget.findMany({
    where: {
      user_id: userId,
      is_active: true,
      start_date: { lte: ahoraParaPresupuestos },
      end_date: { gte: ahoraParaPresupuestos },
    },
    include: { category: { select: { name: true, icon: true } } },
  });

  const ETIQUETA_PERIODO: Record<string, string> = {
    weekly: 'semanal', biweekly: 'quincenal', monthly: 'mensual', yearly: 'anual',
  };

  // OJO: en un presupuesto de INGRESO todo se invierte. `spent` no es "gastado"
  // sino "recibido", y un porcentaje BAJO es MALO (va corto de facturación), no
  // bueno. Antes esto trataba todo como gasto: un presupuesto de ingreso con
  // 5.000 de 60.000 daba 8% y estado VERDE, y Zenio felicitaba al usuario por ir
  // "muy bien" cuando en realidad le faltaba el 92% de lo que esperaba cobrar.
  //
  // Se manda el `tipo` y campos con nombres distintos por tipo, para que el
  // modelo no pueda confundirlos aunque el prompt falle.
  const presupuestosResumen = presupuestos.map(b => {
    const pct = b.amount > 0 ? Math.round((b.spent / b.amount) * 100) : 0;
    const esIngreso = b.type === 'INCOME';

    // Días que le quedan a ESTE presupuesto, no al mes. El prompt del Analista
    // pide decir "quedan N días del período" y solo se le daba
    // `diasRestantesMes`: en una meta quincenal Zenio decía "te faltan 40.000 y
    // quedan 22 días" cuando la quincena cerraba en 4. Justo donde el porcentaje
    // bajo es el problema, se subestimaba la urgencia.
    const msRestantes = b.end_date.getTime() - ahoraParaPresupuestos.getTime();
    const diasRestantesPeriodo = Math.max(0, Math.ceil(msRestantes / 86400000));
    const periodoInfo = {
      periodo: ETIQUETA_PERIODO[b.period] || b.period,
      diasRestantesPeriodo,
      cierra: b.end_date.toISOString().split('T')[0],
      descripcion: b.description || undefined,
    };

    if (esIngreso) {
      return {
        tipo: 'ingreso',
        categoria: b.category.name,
        ...periodoInfo,
        meta: b.amount,
        recibido: b.spent,
        porcentajeAlcanzado: pct,
        // Invertido: cuanto MENOS lleva, peor va.
        estado: pct >= 100 ? 'LOGRADO' : pct >= 70 ? 'VERDE' : pct >= 40 ? 'AMARILLO' : 'ROJO',
        falta: Math.max(0, b.amount - b.spent),
        nota: 'Es una META de ingresos: mientras más alto el porcentaje, mejor. Quedarse corto es lo malo. Si hablas de plazo, usa `diasRestantesPeriodo`, NO los días que quedan del mes.',
      };
    }

    return {
      tipo: 'gasto',
      categoria: b.category.name,
      ...periodoInfo,
      asignado: b.amount,
      gastado: b.spent,
      porcentajeUso: pct,
      estado: pct >= 90 ? 'ROJO' : pct >= 70 ? 'AMARILLO' : 'VERDE',
      restante: b.amount - b.spent,
      nota: 'Es un TECHO de gasto: mientras más alto el porcentaje, peor. Pasarse es lo malo. Si hablas de plazo, usa `diasRestantesPeriodo`, NO los días que quedan del mes.',
    };
  });

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

    // Log OpenAI usage - Responses API (Agents)
    if (response.usage) {
      const cost = calculateOpenAICost(
        ZENIO_MODEL,
        response.usage.input_tokens,
        response.usage.output_tokens
      );
      OpenAiUsageService.logUsageAsync({
        userId,
        feature: 'zenio_agents',
        model: ZENIO_MODEL,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        conversationId: response.id,
        status: 'success',
      });
    }

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

    // 11. Obtener respuesta final (limpiando los marcadores de citación de file_search)
    const assistantResponse = stripFileCitations(response.output_text) || 'No se pudo obtener respuesta.';

    // 12. Incrementar contador
    let zenioUsage = { used: 0, limit: 15, remaining: 15 };
    try {
      if (!autoGreeting && !isOnboarding) {
        // zenioQueriesUsed = cuota mensual (se resetea); zenioMessagesTotal = acumulado
        // de por vida para la métrica de engagement del dashboard.
        // EXENCIÓN (activación / H13): si el mensaje REGISTRÓ una transacción, NO se
        // consume la cuota mensual — para no penalizar el hábito de anotar gastos por
        // Zenio. Igual cuenta como interacción para la métrica de engagement.
        const registroTransaccion = executedActions.some((a: any) => a.action === 'transaction_created');
        const updatedSub = await prisma.subscription.update({
          where: { userId },
          data: {
            zenioMessagesTotal: { increment: 1 },
            ...(registroTransaccion ? {} : { zenioQueriesUsed: { increment: 1 } }),
          },
        });
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
