import OpenAI from 'openai';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Categorias predefinidas para mapeo
const CATEGORY_MAPPINGS: Record<string, string[]> = {
  'Alimentacion': ['comida', 'restaurante', 'supermercado', 'grocery', 'food', 'restaurant', 'cafe', 'cafeteria', 'panaderia', 'colmado'],
  'Transporte': ['gasolina', 'gas', 'uber', 'taxi', 'transporte', 'parking', 'estacionamiento', 'peaje', 'toll'],
  'Entretenimiento': ['cine', 'netflix', 'spotify', 'entretenimiento', 'juegos', 'games', 'bar', 'disco'],
  'Compras': ['tienda', 'store', 'amazon', 'compra', 'shopping', 'mall', 'ropa', 'electronica'],
  'Salud': ['farmacia', 'pharmacy', 'hospital', 'medico', 'clinica', 'doctor', 'salud'],
  'Servicios': ['luz', 'agua', 'internet', 'telefono', 'cable', 'utilities', 'servicio'],
  'Educacion': ['escuela', 'universidad', 'curso', 'libro', 'educacion', 'school'],
  'Viajes': ['hotel', 'vuelo', 'flight', 'airbnb', 'viaje', 'travel', 'aeropuerto'],
  'Hogar': ['ferreteria', 'home', 'hogar', 'muebles', 'decoracion'],
  'Otros': []
};

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

export class EmailParserService {

  /**
   * Parsea el contenido de un email bancario usando AI
   */
  static async parseEmailContent(
    emailContent: string,
    subject: string,
    bankName?: string
  ): Promise<ParserResult> {
    try {
      const prompt = this.buildParserPrompt(emailContent, subject, bankName);

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
La categoria debe ser una de: Alimentacion, Transporte, Entretenimiento, Compras, Salud, Servicios, Educacion, Viajes, Hogar, Otros.`
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
    bankName?: string
  ): string {
    return `Extrae la informacion de esta notificacion bancaria${bankName ? ` de ${bankName}` : ''}:

ASUNTO: ${subject}

CONTENIDO:
${emailContent.substring(0, 3000)}

Responde SOLO con este JSON:
{
  "amount": <numero positivo>,
  "currency": "<RD$|USD|EUR|DOP>",
  "merchant": "<nombre del comercio/establecimiento>",
  "category": "<Alimentacion|Transporte|Entretenimiento|Compras|Salud|Servicios|Educacion|Viajes|Hogar|Otros>",
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
   * Normaliza y valida la categoria
   */
  private static normalizeCategory(category: string, merchant?: string): string {
    const validCategories = [
      'Alimentacion', 'Transporte', 'Entretenimiento', 'Compras',
      'Salud', 'Servicios', 'Educacion', 'Viajes', 'Hogar', 'Otros'
    ];

    if (category && validCategories.includes(category)) {
      return category;
    }

    // Intentar categorizar por el nombre del comercio
    if (merchant) {
      const merchantLower = merchant.toLowerCase();
      for (const [cat, keywords] of Object.entries(CATEGORY_MAPPINGS)) {
        if (keywords.some(k => merchantLower.includes(k))) {
          return cat;
        }
      }
    }

    return 'Otros';
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

    // Categoria valida
    if (parsed.category && parsed.category !== 'Otros') confidence += 10;

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
   */
  static async getDefaultExpenseCategory(): Promise<string> {
    const category = await prisma.category.findFirst({
      where: {
        name: 'Otros',
        type: 'EXPENSE'
      }
    });

    if (category) return category.id;

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
