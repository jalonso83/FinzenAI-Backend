import OpenAI from 'openai';
import { PrismaClient } from '@prisma/client';
import { merchantMappingService } from './merchantMappingService';

const prisma = new PrismaClient();
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

export interface ParsedTransaction {
  amount: number;
  currency: string;
  merchant: string;
  category: string;
  categoryId?: string;  // ID de la categoría si se encontró en mapeo
  date: string;
  cardLast4?: string;
  authorizationCode?: string;
  description?: string;
  confidence: number;
  categorySource?: 'mapping_user' | 'mapping_global' | 'ai';  // Origen de la categorización
}

export interface ParserResult {
  success: boolean;
  transaction?: ParsedTransaction;
  error?: string;
  rawResponse?: string;
}

// Keywords que indican pago de tarjeta (NO son consumos)
// Estos emails son cuando el usuario PAGA su tarjeta, no cuando hace un consumo
const PAYMENT_KEYWORDS = [
  // Pagos recibidos - formato general
  'pago recibido',
  'pago exitoso',
  'pago aplicado',
  'pago procesado',
  'pago realizado a tu tarjeta',
  'pago a tu tarjeta',
  'pago efectuado',
  // APAP y bancos dominicanos - "ha recibido un pago"
  'ha recibido un pago',
  'recibido un pago',
  'recibio un pago',
  'recibió un pago',
  // Banreservas - "Pago realizado"
  'pago realizado',
  '¡pago realizado!',
  'pago de tarjeta de credito propio',
  'pago de tarjeta de crédito propio',
  'pago de tarjeta de credito fue realizado',
  'pago de tarjeta de crédito fue realizado',
  // Abonos
  'abono recibido',
  'abono aplicado',
  'abono a tu tarjeta',
  'abono exitoso',
  'credito a tu cuenta',
  'crédito a tu cuenta',
  // Pagos de tarjeta
  'pago de tarjeta',
  'pago a tarjeta',
  'pago tc',
  'pago tarjeta de credito',
  'pago tarjeta de crédito',
  // Pagos mínimos/totales
  'pago minimo',
  'pago mínimo',
  'pago total',
  'pago parcial',
  // Confirmaciones
  'gracias por tu pago',
  'hemos recibido tu pago',
  'tu pago fue procesado',
  'tu pago ha sido',
  'confirmacion de pago',
  'confirmación de pago',
  'confirmamos tu pago',
  'recibimos tu pago',
  // Transferencias entrantes (no son gastos)
  'transferencia recibida',
  'deposito recibido',
  'depósito recibido',
  // Bancos dominicanos específicos
  'aplicacion de pago',
  'aplicación de pago',
  'pago tdc',
  'acreditado a su cuenta',
  'acreditamos a tu',
  // English
  'payment received',
  'payment applied',
  'payment processed',
  'thank you for your payment'
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
   * @param emailContent - Contenido del email
   * @param subject - Asunto del email
   * @param bankName - Nombre del banco (opcional)
   * @param userCountry - País del usuario para contexto (opcional)
   * @param userId - ID del usuario para buscar mapeos personalizados (opcional)
   */
  static async parseEmailContent(
    emailContent: string,
    subject: string,
    bankName?: string,
    userCountry?: string,
    userId?: string
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
            content: `Eres un experto en extraer datos de notificaciones bancarias de CONSUMOS y COMPRAS.

IMPORTANTE - DEBES IGNORAR estos tipos de emails (responde con is_payment_email: true):
- Pagos de tarjeta de credito (cuando el usuario PAGA su tarjeta)
- Abonos recibidos
- Confirmaciones de pago
- Transferencias recibidas
- Depositos
- Cualquier email que NO sea un CONSUMO o COMPRA

Solo extrae datos de emails que sean CONSUMOS/COMPRAS/CARGOS (cuando el usuario GASTA dinero en un comercio).

Siempre responde UNICAMENTE con JSON valido, sin texto adicional.
Si el email es un pago/abono/deposito, responde: {"is_payment_email": true}
Si no puedes extraer algun dato, usa null.
El monto siempre debe ser un numero positivo.
La fecha debe estar en formato ISO 8601.
La moneda debe ser el codigo (RD$, USD, EUR, DOP).

CATEGORIZACIÓN INTELIGENTE:
Analiza el nombre del comercio para determinar la categoría correcta. Presta atención a prefijos y palabras clave:
- "SM", "SUPER", "SUPERMERCADO", "MARKET", "MERCADO", "COLMADO" → Supermercado/Alimentación
- "REST", "RESTAURANT", "CAFE", "COFFEE", "HELADERIA", "HELADOS", "PIZZA", "POLLO", "BURGER", "SUSHI", "BAR", "FOOD" → Comida/Restaurantes
- "GAS", "GASOLINERA", "ESTACION", "PEAJE", "PARKING", "PARQUEO" → Transporte
- "FARM", "FARMACIA", "CLINICA", "HOSPITAL", "LAB", "MEDIC", "OPTICA" → Salud
- "TIENDA", "STORE", "ROPA", "FASHION", "SHOES", "ZAPATOS" → Ropa/Vestimenta
- "CINE", "CINEMA", "TEATRO", "JUEGOS", "GAMES" → Entretenimiento
- "ELECTRIC", "AGUA", "WATER", "GAS", "INTERNET", "CABLE", "TELEFON" → Servicios/Facturas
- "SCHOOL", "COLEGIO", "UNIVERSIDAD", "CURSO", "LIBRERIA", "BOOKS" → Educación
- "FERRET", "HARDWARE", "CONSTRUC", "MUEBLE" → Hogar

El usuario reside en: ${userCountry}. Usa tu conocimiento de comercios y establecimientos de ese país para categorizar correctamente.

IMPORTANTE: La categoria DEBE ser exactamente una de estas opciones: ${categoryList}.
Elige la que MEJOR corresponda analizando el nombre del comercio.
Si no encuentras una categoría apropiada, usa "${fallbackCategory}".
NUNCA uses "Prestamos y Deudas" para consumos - esa categoria es solo para prestamos bancarios reales.`
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

      // Si la AI detectó que es un pago de tarjeta, ignorar
      if (parsed.is_payment_email === true) {
        console.log(`[EmailParser] AI detected payment email, skipping: ${subject}`);
        return {
          success: false,
          error: 'PAYMENT_EMAIL_SKIPPED: AI detectó que es un pago de tarjeta, no un consumo'
        };
      }

      // Validar datos minimos requeridos
      if (!parsed.amount || parsed.amount <= 0) {
        return { success: false, error: 'Could not extract valid amount', rawResponse: content };
      }

      const merchant = parsed.merchant || 'Desconocido';
      let category = this.normalizeCategory(parsed.category, merchant);
      let categoryId: string | undefined;
      let categorySource: 'mapping_user' | 'mapping_global' | 'ai' = 'ai';

      // ============================================
      // SISTEMA DE APRENDIZAJE: Buscar mapeo primero
      // ============================================
      if (userId && merchant !== 'Desconocido') {
        try {
          const mapping = await merchantMappingService.findMapping(userId, merchant);

          if (mapping) {
            categoryId = mapping.categoryId;
            category = mapping.categoryName;
            categorySource = mapping.source === 'user' ? 'mapping_user' : 'mapping_global';

            console.log(`[EmailParser] Usando mapeo ${mapping.source} para "${merchant}" -> "${category}" (confianza: ${mapping.confidence}%)`);
          } else {
            console.log(`[EmailParser] No hay mapeo para "${merchant}", usando categoría de IA: "${category}"`);
          }
        } catch (error) {
          console.error('[EmailParser] Error buscando mapeo:', error);
          // Continuar con la categoría de la IA
        }
      }

      const transaction: ParsedTransaction = {
        amount: Math.abs(Number(parsed.amount)),
        currency: this.normalizeCurrency(parsed.currency),
        merchant: merchant,
        category: category,
        categoryId: categoryId,
        date: parsed.date || new Date().toISOString(),
        cardLast4: parsed.cardLast4 || parsed.card_last4 || undefined,
        authorizationCode: parsed.authorizationCode || parsed.authorization_code || undefined,
        description: parsed.description || undefined,
        confidence: this.calculateConfidence(parsed),
        categorySource: categorySource
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
