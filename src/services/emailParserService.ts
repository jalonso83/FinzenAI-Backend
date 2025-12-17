import OpenAI from 'openai';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

export interface ParsedTransaction {
  amount: number;
  currency: string;
  merchant: string;
  category: string;
  date: string;
  cardLast4?: string;
  authorizationCode?: string;
  description?: string;
  confidence: number;
}

export interface ParserResult {
  success: boolean;
  transaction?: ParsedTransaction;
  error?: string;
  rawResponse?: string;
}

// Keywords que indican pago de tarjeta (NO son consumos)
const PAYMENT_KEYWORDS = [
  'pago recibido',
  'pago exitoso',
  'pago aplicado',
  'abono recibido',
  'abono aplicado',
  'pago de tarjeta',
  'pago a tarjeta',
  'pago minimo',
  'pago mínimo',
  'gracias por tu pago',
  'hemos recibido tu pago',
  'tu pago fue procesado',
  'confirmacion de pago',
  'confirmación de pago',
  'payment received',
  'payment applied'
];

export class EmailParserService {

  /**
   * Verifica si el email es un pago de tarjeta (no un consumo)
   * Estos deben ser ignorados para evitar contar doble
   */
  static isPaymentEmail(subject: string, emailContent: string): boolean {
    const textToCheck = `${subject} ${emailContent}`.toLowerCase();

    return PAYMENT_KEYWORDS.some(keyword => textToCheck.includes(keyword.toLowerCase()));
  }

  /**
   * Parsea el contenido de un email bancario usando AI
   */
  static async parseEmailContent(
    emailContent: string,
    subject: string,
    bankName?: string
  ): Promise<ParserResult> {
    try {
      // Verificar si es un pago de tarjeta (no un consumo)
      if (this.isPaymentEmail(subject, emailContent)) {
        return {
          success: false,
          error: 'PAYMENT_EMAIL_SKIPPED: Este email es un pago de tarjeta, no un consumo'
        };
      }

      // Obtener categorías de GASTOS de la base de datos
      const expenseCategories = await prisma.category.findMany({
        where: { type: 'EXPENSE' },
        select: { name: true }
      });
      const categoryNames = expenseCategories.map(c => c.name);
      const categoryList = categoryNames.join(', ');

      console.log(`[EmailParser] Using ${categoryNames.length} categories from DB: ${categoryList}`);

      const prompt = this.buildParserPrompt(emailContent, subject, bankName, categoryList);

      // Detectar categoría de fallback (Otros, Otros Gastos, etc.)
      const fallbackCategory = categoryNames.find(c =>
        c.toLowerCase().includes('otro')
      ) || categoryNames[0];

      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `Eres un experto en extraer datos de notificaciones bancarias de transacciones.
Tu trabajo es extraer informacion estructurada de emails de alertas bancarias.
Siempre responde UNICAMENTE con JSON valido, sin texto adicional.
Si no puedes extraer algun dato, usa null.
El monto siempre debe ser un numero positivo.
La fecha debe estar en formato ISO 8601.
La moneda debe ser el codigo (RD$, USD, EUR, DOP).
IMPORTANTE: La categoria DEBE ser exactamente una de estas opciones: ${categoryList}.
Elige la que mejor corresponda al tipo de gasto segun el comercio.
Si no puedes determinar la categoria con certeza, usa "${fallbackCategory}".`
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.1,
        max_tokens: 500,
        response_format: { type: 'json_object' }
      });

      const content = response.choices[0]?.message?.content;

      if (!content) {
        return { success: false, error: 'No response from AI' };
      }

      const parsed = JSON.parse(content);

      // Validar datos minimos requeridos
      if (!parsed.amount || parsed.amount <= 0) {
        return { success: false, error: 'Could not extract valid amount', rawResponse: content };
      }

      // Normalizar y validar categoria
      const category = this.normalizeCategory(parsed.category, parsed.merchant);

      const transaction: ParsedTransaction = {
        amount: Math.abs(Number(parsed.amount)),
        currency: this.normalizeCurrency(parsed.currency),
        merchant: parsed.merchant || 'Desconocido',
        category: category,
        date: parsed.date || new Date().toISOString(),
        cardLast4: parsed.cardLast4 || parsed.card_last4 || undefined,
        authorizationCode: parsed.authorizationCode || parsed.authorization_code || undefined,
        description: parsed.description || undefined,
        confidence: this.calculateConfidence(parsed)
      };

      return { success: true, transaction };

    } catch (error: any) {
      console.error('[EmailParserService] Parse error:', error);
      return {
        success: false,
        error: error.message || 'Unknown parsing error'
      };
    }
  }

  /**
   * Construye el prompt para el parser
   */
  private static buildParserPrompt(
    emailContent: string,
    subject: string,
    bankName?: string,
    categoryList?: string
  ): string {
    // categoryList siempre viene de la DB, no debería ser undefined
    if (!categoryList) {
      throw new Error('No categories provided - must query from database first');
    }

    return `Extrae la informacion de esta notificacion bancaria${bankName ? ` de ${bankName}` : ''}:

ASUNTO: ${subject}

CONTENIDO:
${emailContent.substring(0, 3000)}

Responde SOLO con este JSON:
{
  "amount": <numero positivo>,
  "currency": "<RD$|USD|EUR|DOP>",
  "merchant": "<nombre del comercio/establecimiento>",
  "category": "<DEBE ser exactamente una de: ${categoryList}>",
  "date": "<fecha ISO 8601>",
  "cardLast4": "<ultimos 4 digitos de tarjeta o null>",
  "authorizationCode": "<codigo de autorizacion o null>",
  "description": "<descripcion adicional o null>"
}`;
  }

  /**
   * Normaliza la moneda al formato estandar
   */
  private static normalizeCurrency(currency: string): string {
    if (!currency) return 'RD$';

    const currencyMap: Record<string, string> = {
      'DOP': 'RD$',
      'RD': 'RD$',
      'RD$': 'RD$',
      'PESOS': 'RD$',
      'USD': 'USD',
      'US$': 'USD',
      'DOLARES': 'USD',
      'EUR': 'EUR',
      'EUROS': 'EUR'
    };

    return currencyMap[currency.toUpperCase()] || 'RD$';
  }

  /**
   * Normaliza y valida la categoria - simplemente retorna lo que la AI devolvió
   * ya que la AI recibe las categorías reales de la base de datos
   */
  private static normalizeCategory(category: string, merchant?: string): string {
    // La AI ya recibe las categorías de la DB, así que simplemente retornamos
    // lo que devolvió. La validación real se hace en findCategoryByName
    return category || '';
  }

  /**
   * Calcula un score de confianza para el parsing
   */
  private static calculateConfidence(parsed: any): number {
    let confidence = 0;

    // Monto valido
    if (parsed.amount && parsed.amount > 0) confidence += 30;

    // Comercio identificado
    if (parsed.merchant && parsed.merchant !== 'Desconocido') confidence += 25;

    // Fecha valida
    if (parsed.date) {
      try {
        new Date(parsed.date);
        confidence += 20;
      } catch { }
    }

    // Ultimos 4 digitos
    if (parsed.cardLast4 && /^\d{4}$/.test(parsed.cardLast4)) confidence += 15;

    // Categoria identificada (si tiene alguna)
    if (parsed.category) confidence += 10;

    return confidence;
  }

  /**
   * Busca la categoria en la base de datos por nombre
   */
  static async findCategoryByName(categoryName: string): Promise<string | null> {
    const category = await prisma.category.findFirst({
      where: {
        name: {
          contains: categoryName,
          mode: 'insensitive'
        },
        type: 'EXPENSE'
      }
    });

    return category?.id || null;
  }

  /**
   * Obtiene la categoria por defecto para gastos
   * Busca una categoría que contenga "otro" en el nombre (ej: "Otros", "Otros gastos")
   */
  static async getDefaultExpenseCategory(): Promise<string> {
    // Buscar categoría que contenga "otro" (Otros, Otros gastos, etc.)
    const otrosCategory = await prisma.category.findFirst({
      where: {
        name: {
          contains: 'otro',
          mode: 'insensitive'
        },
        type: 'EXPENSE'
      }
    });

    if (otrosCategory) return otrosCategory.id;

    // Si no existe, buscar cualquier categoria de gasto
    const anyCategory = await prisma.category.findFirst({
      where: { type: 'EXPENSE' }
    });

    return anyCategory?.id || '';
  }

  /**
   * Detecta duplicados potenciales
   */
  static async checkForDuplicate(
    userId: string,
    amount: number,
    date: string,
    merchant?: string
  ): Promise<boolean> {
    const transactionDate = new Date(date);
    const startDate = new Date(transactionDate);
    startDate.setHours(0, 0, 0, 0);
    const endDate = new Date(transactionDate);
    endDate.setHours(23, 59, 59, 999);

    const existing = await prisma.transaction.findFirst({
      where: {
        userId,
        amount,
        date: {
          gte: startDate,
          lte: endDate
        },
        type: 'EXPENSE',
        ...(merchant && {
          description: {
            contains: merchant,
            mode: 'insensitive'
          }
        })
      }
    });

    return !!existing;
  }
}

export default EmailParserService;
