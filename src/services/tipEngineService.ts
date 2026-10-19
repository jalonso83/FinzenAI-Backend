import { prisma } from '../lib/prisma';
import { openai } from '../openaiClient';
import { NotificationService } from './notificationService';
import { subscriptionService } from './subscriptionService';
import crypto from 'crypto';

import { logger } from '../utils/logger';
import { OpenAiUsageService } from './openAiUsageService';

// Configuración
const TIP_COOLDOWN_HOURS = 72; // No enviar otro tip si recibió uno en las últimas 72 horas
const MAX_TIPS_PER_WEEK = 2;
// Un push se lee de un vistazo: más largo se corta en la pantalla bloqueada.
const MAX_CONTENIDO_TIP = 140;
const MAX_TITULO_TIP = 40;

const SIMBOLOS: Record<string, string> = { DOP: 'RD$', 'RD$': 'RD$', RD: 'RD$', USD: 'US$', 'US$': 'US$', EUR: '€', MXN: 'MX$', COP: 'COP$' };

/** "RD$12,500": símbolo (no "DOP") y sin centavos, como lo leería una persona. */
function dineroTip(currency: string, monto: number): string {
  const simbolo = SIMBOLOS[(currency || '').toUpperCase()] ?? (currency ? `${currency} ` : 'RD$');
  return `${simbolo}${Math.round(monto).toLocaleString('es-DO')}`;
}

export interface Enfoque {
  clave: string;
  datos: string;
}

export interface UserFinancialContext {
  userId: string;
  userName: string;
  currency: string;
  // Resumen financiero
  totalIncome: number;
  totalExpenses: number;
  savingsRate: number;
  // Top categorías de gasto
  topExpenseCategories: { category: string; amount: number; percentage: number }[];
  // Estado de presupuestos
  budgets: { name: string; spent: number; limit: number; percentage: number }[];
  exceededBudgets: string[];
  // Estado de metas
  goals: { name: string; current: number; target: number; percentage: number; daysSinceContribution: number | null }[];
  stagnantGoals: string[];
  // Gastos hormiga
  antExpenseTotal: number;
  antExpensePercentage: number;
  // Contexto temporal
  currentMonth: string;
  dayOfMonth: number;
  isEndOfMonth: boolean;
  isStartOfMonth: boolean;
  diasParaFinDeMes: number;
}

export interface GeneratedTip {
  title: string;
  content: string;
  category: string;
}

export class TipEngineService {
  /**
   * Genera y envía un tip personalizado a un usuario
   */
  static async generateAndSendTip(userId: string): Promise<{
    sent: boolean;
    reason: string;
    tip?: GeneratedTip;
  }> {
    try {
      // 1. Verificar que es usuario PRO
      const subscription = await subscriptionService.getUserSubscription(userId);
      if (subscription.plan !== 'PRO') {
        return { sent: false, reason: 'Usuario no es PRO' };
      }

      // 2. Verificar preferencias de notificación
      const preferences = await prisma.notificationPreferences.findUnique({
        where: { userId }
      });

      if (!preferences?.tipsEnabled) {
        return { sent: false, reason: 'Tips deshabilitados por el usuario' };
      }

      // 3. Verificar cooldown (no enviar si recibió tip recientemente)
      const recentTip = await prisma.userTipHistory.findFirst({
        where: {
          userId,
          sentAt: {
            gte: new Date(Date.now() - TIP_COOLDOWN_HOURS * 60 * 60 * 1000)
          }
        },
        orderBy: { sentAt: 'desc' }
      });

      if (recentTip) {
        const hoursAgo = Math.round((Date.now() - recentTip.sentAt.getTime()) / (1000 * 60 * 60));
        return { sent: false, reason: `Ya recibió tip hace ${hoursAgo} horas` };
      }

      // 4. Verificar límite semanal
      const startOfWeek = new Date();
      startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());
      startOfWeek.setHours(0, 0, 0, 0);

      const tipsThisWeek = await prisma.userTipHistory.count({
        where: {
          userId,
          sentAt: { gte: startOfWeek }
        }
      });

      if (tipsThisWeek >= MAX_TIPS_PER_WEEK) {
        return { sent: false, reason: `Ya recibió ${tipsThisWeek} tips esta semana (máx: ${MAX_TIPS_PER_WEEK})` };
      }

      // 5. Recopilar contexto financiero del usuario
      const context = await this.gatherUserContext(userId);

      // 6. Generar tip con IA (con otro tema que el del último tip)
      const ultimoTip = await prisma.userTipHistory.findFirst({
        where: { userId },
        orderBy: { sentAt: 'desc' },
        select: { category: true },
      });
      const tip = await this.generateTipWithAI(context, ultimoTip?.category);

      if (!tip) {
        return { sent: false, reason: 'No se pudo generar el tip' };
      }

      // 7. Verificar que no sea un tip repetido (hash del contenido)
      const tipHash = this.hashTip(tip.content);
      const duplicateTip = await prisma.userTipHistory.findFirst({
        where: {
          userId,
          tipHash,
          sentAt: {
            gte: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000) // 60 días
          }
        }
      });

      if (duplicateTip) {
        return { sent: false, reason: 'Tip duplicado detectado, regenerando...' };
      }

      // 8. Enviar notificación
      const result = await NotificationService.notifyTip(userId, tip.title, tip.content);

      if (!result.success && result.successCount === 0) {
        return { sent: false, reason: 'Error enviando notificación' };
      }

      // 9. Guardar en historial
      await prisma.userTipHistory.create({
        data: {
          userId,
          tipHash,
          title: tip.title,
          content: tip.content,
          category: tip.category
        }
      });

      logger.log(`[TipEngine] ✅ Tip enviado a usuario ${userId}: "${tip.title}"`);

      return {
        sent: true,
        reason: 'Tip enviado exitosamente',
        tip
      };

    } catch (error: any) {
      logger.error(`[TipEngine] Error generando tip para usuario ${userId}:`, error);
      return { sent: false, reason: `Error: ${error.message}` };
    }
  }

  /**
   * Recopila el contexto financiero del usuario
   */
  private static async gatherUserContext(userId: string): Promise<UserFinancialContext> {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);

    // Obtener usuario
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, currency: true }
    });

    // Transacciones del mes
    const transactions = await prisma.transaction.findMany({
      where: {
        userId,
        date: { gte: startOfMonth, lte: now }
      },
      include: { category: true }
    });

    // Calcular ingresos y gastos
    const totalIncome = transactions
      .filter(t => t.type === 'INCOME')
      .reduce((sum, t) => sum + Number(t.amount), 0);

    const totalExpenses = transactions
      .filter(t => t.type === 'EXPENSE')
      .reduce((sum, t) => sum + Number(t.amount), 0);

    const savingsRate = totalIncome > 0 ? ((totalIncome - totalExpenses) / totalIncome) * 100 : 0;

    // Top categorías de gasto
    const expensesByCategory = new Map<string, number>();
    transactions
      .filter(t => t.type === 'EXPENSE')
      .forEach(t => {
        const catName = t.category?.name || 'Otros';
        expensesByCategory.set(catName, (expensesByCategory.get(catName) || 0) + Number(t.amount));
      });

    const topExpenseCategories = Array.from(expensesByCategory.entries())
      .map(([category, amount]) => ({
        category,
        amount,
        percentage: totalExpenses > 0 ? (amount / totalExpenses) * 100 : 0
      }))
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 5);

    // Presupuestos activos
    const budgets = await prisma.budget.findMany({
      where: {
        user_id: userId,
        is_active: true,
      // SOLO presupuestos de GASTO. Un presupuesto de INGRESO superado es una
      // BUENA noticia (facturó más de lo que esperaba); colarlo aquí haría que
      // apareciera como "presupuesto excedido" y la IA generaría un consejo
      // regañando al usuario por ganar de más.
      type: 'EXPENSE',
        start_date: { lte: now },
        end_date: { gte: now }
      }
    });

    const budgetStatus = budgets.map(b => ({
      name: b.name,
      spent: Number(b.spent) || 0,
      limit: Number(b.amount),
      percentage: Number(b.amount) > 0 ? ((Number(b.spent) || 0) / Number(b.amount)) * 100 : 0
    }));

    const exceededBudgets = budgetStatus
      .filter(b => b.percentage >= 100)
      .map(b => b.name);

    // Metas activas
    const goals = await prisma.goal.findMany({
      where: {
        userId,
        isActive: true,
        isCompleted: false
      }
    });

    const goalStatus = goals.map(g => {
      const daysSinceContribution = g.lastContributionDate
        ? Math.floor((now.getTime() - g.lastContributionDate.getTime()) / (1000 * 60 * 60 * 24))
        : null;

      return {
        name: g.name,
        current: Number(g.currentAmount),
        target: Number(g.targetAmount),
        percentage: Number(g.targetAmount) > 0 ? (Number(g.currentAmount) / Number(g.targetAmount)) * 100 : 0,
        daysSinceContribution
      };
    });

    const stagnantGoals = goalStatus
      .filter(g => g.daysSinceContribution !== null && g.daysSinceContribution >= 14)
      .map(g => g.name);

    // Gastos hormiga (transacciones pequeñas < 500 en moneda local)
    const antExpenseThreshold = 500;
    const antExpenses = transactions
      .filter(t => t.type === 'EXPENSE' && Number(t.amount) <= antExpenseThreshold)
      .reduce((sum, t) => sum + Number(t.amount), 0);

    const antExpensePercentage = totalExpenses > 0 ? (antExpenses / totalExpenses) * 100 : 0;

    // Contexto temporal
    const months = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
      'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

    return {
      userId,
      userName: user?.name || 'Usuario',
      currency: user?.currency || 'RD$',
      totalIncome,
      totalExpenses,
      savingsRate,
      topExpenseCategories,
      budgets: budgetStatus,
      exceededBudgets,
      goals: goalStatus,
      stagnantGoals,
      antExpenseTotal: antExpenses,
      antExpensePercentage,
      currentMonth: months[now.getMonth()],
      dayOfMonth: now.getDate(),
      isEndOfMonth: now.getDate() >= 25,
      isStartOfMonth: now.getDate() <= 5,
      diasParaFinDeMes: endOfMonth.getDate() - now.getDate()
    };
  }

  /**
   * Elige el ÚNICO tema del tip, según el caso y en orden de urgencia. Antes la
   * IA recibía todo y mezclaba cuatro consejos en un push que no se leía entero.
   * Se salta el tema del tip anterior para no repetir lo mismo cada vez.
   */
  static elegirEnfoque(ctx: UserFinancialContext, evitar?: string | null): Enfoque {
    const m = (n: number) => dineroTip(ctx.currency, n);
    const candidatos: Enfoque[] = [];

    const excedido = [...ctx.budgets].filter(b => b.percentage >= 100).sort((a, b) => (b.spent - b.limit) - (a.spent - a.limit))[0];
    if (excedido) {
      candidatos.push({
        clave: 'presupuesto_excedido',
        datos: `Presupuesto "${excedido.name}": límite ${m(excedido.limit)}, lleva ${m(excedido.spent)}. YA SE PASÓ por ${m(excedido.spent - excedido.limit)}: ese dinero ya se gastó, NO es dinero que sobra ni que pueda usar. El tip es para no pasarse más lo que queda de mes.`,
      });
    }

    const cerca = [...ctx.budgets].filter(b => b.percentage >= 80 && b.percentage < 100).sort((a, b) => b.percentage - a.percentage)[0];
    if (cerca) {
      candidatos.push({
        clave: 'presupuesto_cerca',
        datos: `Presupuesto "${cerca.name}": usado ${cerca.percentage.toFixed(0)}% (${m(cerca.spent)} de ${m(cerca.limit)}). Le quedan ${m(cerca.limit - cerca.spent)} y ${ctx.diasParaFinDeMes === 0 ? 'hoy es el último día del mes' : ctx.diasParaFinDeMes === 1 ? 'falta 1 día para que termine el mes' : `faltan ${ctx.diasParaFinDeMes} días para que termine el mes`}.`,
      });
    }

    const estancada = [...ctx.goals]
      .filter(g => g.daysSinceContribution !== null && g.daysSinceContribution >= 14)
      .sort((a, b) => (b.daysSinceContribution ?? 0) - (a.daysSinceContribution ?? 0))[0];
    if (estancada) {
      candidatos.push({
        clave: 'meta_estancada',
        datos: `Meta "${estancada.name}": lleva ${m(estancada.current)} de ${m(estancada.target)} (${estancada.percentage.toFixed(0)}%), y ${estancada.daysSinceContribution} días sin aportar.`,
      });
    }

    if (ctx.antExpensePercentage > 15) {
      candidatos.push({
        clave: 'gastos_hormiga',
        datos: `Gastos pequeños (de ${m(500)} o menos) este mes: ${m(ctx.antExpenseTotal)}, el ${ctx.antExpensePercentage.toFixed(0)}% de todo lo que gastó.`,
      });
    }

    const top = ctx.topExpenseCategories[0];
    if (top && top.percentage >= 25) {
      candidatos.push({
        clave: 'categoria_top',
        datos: `Su mayor gasto del mes es "${top.category}": ${m(top.amount)}, el ${top.percentage.toFixed(0)}% de lo que gastó.`,
      });
    }

    if (ctx.totalIncome > 0) {
      candidatos.push({
        clave: 'ahorro_del_mes',
        datos: ctx.totalIncome >= ctx.totalExpenses
          ? `Este mes le entraron ${m(ctx.totalIncome)} y gastó ${m(ctx.totalExpenses)}: le quedan ${m(ctx.totalIncome - ctx.totalExpenses)} (${ctx.savingsRate.toFixed(0)}% de lo que ganó).`
          : `Este mes le entraron ${m(ctx.totalIncome)} y gastó ${m(ctx.totalExpenses)}: está gastando ${m(ctx.totalExpenses - ctx.totalIncome)} más de lo que ganó.`,
      });
    }

    candidatos.push({ clave: 'general', datos: 'Sin datos suficientes del mes: da un hábito sencillo y concreto para registrar o controlar gastos.' });

    return candidatos.find(c => c.clave !== evitar) ?? candidatos[0];
  }

  /**
   * Genera un tip usando IA
   */
  private static async generateTipWithAI(context: UserFinancialContext, evitar?: string | null): Promise<GeneratedTip | null> {
    const enfoque = this.elegirEnfoque(context, evitar);
    const prompt = this.buildPrompt(context, enfoque);
    const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
      {
        role: 'system',
        content: `Eres Zenio, el asistente financiero de FinZen. Escribes UN tip corto que llega como notificación push al celular.

REGLAS:
- Habla SOLO del tema que te dan. Nada de otros presupuestos, metas o consejos extra.
- "content": UNA oración, máximo ${MAX_CONTENIDO_TIP} caracteres. Tutea, sé directo y di algo concreto que pueda hacer hoy o esta semana.
- "title": máximo ${MAX_TITULO_TIP} caracteres, sin emojis.
- Usa los montos EXACTAMENTE como vienen escritos (con su símbolo). No inventes cifras ni porcentajes.
- Usa el nombre del presupuesto o de la meta tal como viene.
- Si un presupuesto ya se pasó, lo pasado ya se gastó: NUNCA lo llames "extra", "sobrante" ni digas que lo use o lo guarde.
- Responde SOLO en JSON: {"title": "...", "content": "..."}`,
      },
      { role: 'user', content: prompt },
    ];

    try {
      // Hasta dos intentos: si el primero sale largo, se le pide más corto.
      for (let intento = 1; intento <= 2; intento++) {
        const response = await openai.chat.completions.create({
          model: 'gpt-5.4-mini',
          messages,
          temperature: 0.8,
          max_completion_tokens: 200,
        });

        const content = response.choices[0]?.message?.content?.trim();

        // Log OpenAI usage
        OpenAiUsageService.logUsageAsync({
          userId: context.userId,
          feature: 'tip_engine',
          model: 'gpt-5.4-mini',
          inputTokens: response.usage?.prompt_tokens,
          outputTokens: response.usage?.completion_tokens,
          status: 'success',
        });

        if (!content) {
          logger.error('[TipEngine] Respuesta vacía de OpenAI');
          return null;
        }

        // Parsear JSON de la respuesta
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          logger.error('[TipEngine] No se encontró JSON en respuesta:', content);
          return null;
        }

        const crudo = JSON.parse(jsonMatch[0]) as Partial<GeneratedTip>;
        // El título ya lleva 💡 delante (notifyTip): otro emoji sobra.
        const title = String(crudo.title || '').replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}\u200D\uFE0F]/gu, '').replace(/\s+/g, ' ').trim();
        const texto = String(crudo.content || '').trim();

        // Validar estructura
        if (!title || !texto) {
          logger.error('[TipEngine] Tip incompleto:', crudo);
          return null;
        }

        if (texto.length <= MAX_CONTENIDO_TIP + 20 && title.length <= MAX_TITULO_TIP + 10) {
          return { title, content: texto, category: enfoque.clave };
        }

        messages.push({ role: 'assistant', content: jsonMatch[0] });
        messages.push({
          role: 'user',
          content: `Muy largo (${texto.length} caracteres). Reescríbelo en UNA oración de máximo ${MAX_CONTENIDO_TIP} caracteres, mismo tema. Solo el JSON.`,
        });
      }

      logger.error(`[TipEngine] Tip demasiado largo tras 2 intentos para ${context.userId}; no se envía`);
      return null;

    } catch (error: any) {
      logger.error('[TipEngine] Error llamando a OpenAI:', error);
      return null;
    }
  }

  /**
   * Construye el prompt para la IA: solo el tema elegido, con los montos ya
   * escritos como los verá el usuario.
   */
  private static buildPrompt(ctx: UserFinancialContext, enfoque: Enfoque): string {
    const parts: string[] = [];
    parts.push(`Usuario: ${ctx.userName.split(' ')[0]}`);
    parts.push(`Fecha: día ${ctx.dayOfMonth} de ${ctx.currentMonth}${ctx.isEndOfMonth ? ' (fin de mes)' : ctx.isStartOfMonth ? ' (inicio de mes)' : ''}`);
    if (ctx.currentMonth === 'Diciembre') parts.push('Temporada navideña');
    parts.push('');
    parts.push(`TEMA DEL TIP: ${enfoque.clave}`);
    parts.push(enfoque.datos);
    parts.push('');
    parts.push('Escribe el tip sobre este tema y nada más.');
    return parts.join('\n');
  }

  /**
   * Genera hash de un tip para detectar duplicados
   */
  private static hashTip(content: string): string {
    // Normalizar contenido (quitar números y espacios extra)
    const normalized = content.toLowerCase().replace(/\d+/g, 'X').replace(/\s+/g, ' ').trim();
    return crypto.createHash('md5').update(normalized).digest('hex').substring(0, 16);
  }

  /**
   * Método para testing manual
   */
  static async testForUser(userId: string): Promise<{
    context: UserFinancialContext;
    tip: GeneratedTip | null;
    prompt: string;
  }> {
    const context = await this.gatherUserContext(userId);
    const prompt = this.buildPrompt(context, this.elegirEnfoque(context));
    const tip = await this.generateTipWithAI(context);

    return { context, tip, prompt };
  }
}
