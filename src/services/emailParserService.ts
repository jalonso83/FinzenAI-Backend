import OpenAI from 'openai';
import { prisma } from '../lib/prisma';
import { ENV } from '../config/env';
import { merchantMappingService } from './merchantMappingService';
import { logger } from '../utils/logger';
import { OpenAiUsageService } from './openAiUsageService';
import { calculateOpenAICost } from '../config/openaiPricing';
import { ExchangeRateService } from './exchangeRateService';

const openai = new OpenAI({
  apiKey: ENV.OPENAI_API_KEY
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
  // Solo con ingresos activados (config/emailIncome). Sin `type` = gasto, como siempre.
  type?: 'EXPENSE' | 'INCOME';
  payerName?: string;       // Ordenante de la transferencia, si el correo lo trae
  incomeChannel?: IncomeChannel;
}

// Por dónde entró el ingreso. Los depósitos (sucursal, cajero, subagente) no
// dicen quién depositó: puede ser un cliente o el propio usuario llevando su
// efectivo, así que se registran y se le avisa para que lo confirme.
export type IncomeChannel = 'TRANSFERENCIA' | 'SUCURSAL' | 'CAJERO' | 'SUBAGENTE' | 'NOMINA' | 'OTRO';
export const DEPOSIT_CHANNELS: IncomeChannel[] = ['SUCURSAL', 'CAJERO', 'SUBAGENTE'];

export interface ParseOptions {
  // Con true se clasifica GASTO / INGRESO / IGNORAR; con false solo gastos (comportamiento original)
  incluirIngresos?: boolean;
  // Para detectar transferencias entre cuentas del propio usuario
  userName?: string | null;
  userLastName?: string | null;
}

export interface ParserResult {
  success: boolean;
  transaction?: ParsedTransaction;
  error?: string;
  rawResponse?: string;
  // Ingreso cuyo correo no trae el monto: no se registra, se le avisa al usuario
  incomeWithoutAmount?: { incomeChannel: IncomeChannel; description: string };
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
  // Bancos dominicanos específicos
  'aplicacion de pago',
  'aplicación de pago',
  'pago tdc',
  // English
  'payment received',
  'payment applied',
  'payment processed',
  'thank you for your payment'
];

// Dinero que ENTRA a la cuenta (transferencias recibidas, depósitos). Antes
// vivían en PAYMENT_KEYWORDS y se descartaban siempre. Ahora:
//   - ingresos apagados (config/emailIncome) → se siguen descartando igual;
//   - ingresos encendidos → pasan a la IA, que decide si es ingreso, y luego se
//     filtran las transferencias entre cuentas propias.
// Los "abonos" se quedan en PAYMENT_KEYWORDS: en RD casi siempre son el pago de
// la tarjeta, y registrar un pago de tarjeta como ingreso inflaría los ingresos.
const INCOME_KEYWORDS = [
  'transferencia recibida',
  'deposito recibido',
  'depósito recibido',
  'credito a tu cuenta',
  'crédito a tu cuenta',
  'acreditado a su cuenta',
  'acreditamos a tu',
];

// Tratamientos que los bancos anteponen al nombre del ordenante ("SRA ROSANNA…")
const HONORIFICOS = new Set(['SR', 'SRA', 'SRTA', 'SRES', 'DON', 'DONA', 'DR', 'DRA', 'LIC', 'LICDA', 'ING']);

// Transacciones que NO se completaron. Reportado 2026-08-04: la sincronización
// registraba las notificaciones de compras DECLINADAS como gastos reales, porque
// traen comercio y monto igual que una compra exitosa — para el parser eran
// indistinguibles. Esto infla el gasto del usuario con dinero que nunca salió.
//
// Va como filtro de palabras clave ANTES de la IA (determinista y sin costo) y
// además reforzado en el prompt, porque un banco nuevo puede usar un texto que
// no esté en esta lista.
const DECLINED_KEYWORDS = [
  // Declinada / rechazada
  'declinada',
  'declinado',
  'transaccion declinada',
  'transacción declinada',
  'compra declinada',
  'consumo declinado',
  'pago declinado',
  'rechazada',
  'rechazado',
  'transaccion rechazada',
  'transacción rechazada',
  'compra rechazada',
  'pago rechazado',
  'operacion rechazada',
  'operación rechazada',
  // No procesada / fallida
  'no se pudo procesar',
  'no pudo ser procesada',
  'no procesada',
  'transaccion fallida',
  'transacción fallida',
  'intento de transaccion',
  'intento de transacción',
  'transaccion no autorizada',
  'transacción no autorizada',
  'no autorizada',
  'sin autorizacion',
  'sin autorización',
  // Fondos / límite
  'fondos insuficientes',
  'saldo insuficiente',
  'limite excedido',
  'límite excedido',
  // Reversos y anulaciones (tampoco son gasto)
  'transaccion reversada',
  'transacción reversada',
  'reverso de',
  'anulacion de',
  'anulación de',
  'compra anulada',
  'transaccion anulada',
  'transacción anulada',
  // English
  'declined',
  'transaction declined',
  'payment declined',
  'was declined',
  'unable to process',
  'insufficient funds',
  'transaction failed',
  'reversed',
];

// Retiros de efectivo. Decisión de producto (2026-08-05): un retiro NO es un
// gasto — el dinero solo cambia de forma (de la cuenta al bolsillo). El gasto
// real ocurre después, cuando el usuario compra algo, y ese sí lo registra él.
// Contarlo aquí duplicaría el gasto.
//
// Antes de esto no había ninguna regla: el correo llegaba a la IA, que decidía
// caso por caso. Como trae monto y fecha igual que una compra, a veces lo
// registraba como gasto y a veces no. De ahí la inconsistencia reportada.
//
// Estas frases se buscan en ASUNTO + CUERPO. Son compuestas a propósito: la
// palabra "retiro" sola matchearía "plan de retiro" / "cuenta de retiro".
const CASH_WITHDRAWAL_KEYWORDS = [
  // Código Cash / retiro sin tarjeta (Popular, Banreservas, BHD)
  'codigo cash',
  'código cash',
  'retiro de codigo cash',
  'retiro de código cash',
  'retiro con codigo',
  'retiro con código',
  'retiro sin tarjeta',
  'cash code',
  'cardless withdrawal',
  // Retiro en cajero
  'retiro de efectivo',
  'retiro en efectivo',
  'retiro en cajero',
  'retiro por cajero',
  'retiro de cajero',
  'retiro en atm',
  'retiro atm',
  'retiro realizado',
  'retiro exitoso',
  // Avance / adelanto de efectivo (tarjeta de crédito)
  'avance de efectivo',
  'avance en efectivo',
  'adelanto de efectivo',
  'disposicion de efectivo',
  'disposición de efectivo',
  // English
  'cash withdrawal',
  'atm withdrawal',
  'withdrawal at atm',
  'cash advance',
];

// Términos genéricos de cajero. Estos SOLO se buscan en el ASUNTO: en el cuerpo
// aparecen en pies de página publicitarios ("consulta tu saldo en cualquier
// cajero automático") y suprimirían compras legítimas.
// Van con \b para que "atm" no matchee dentro de otra palabra.
const CASH_WITHDRAWAL_SUBJECT_PATTERNS = [
  /\bcajero(s)?\s+autom[aá]tico(s)?\b/,
  /\bcajero\b/,
  /\batm\b/,
];

// Bancos que escriben la fecha como MM-DD-YYYY (en minúsculas, se compara con
// includes). Confirmado con correos reales: Qik, 09-07-2026 = 7-sep-2026.
const BANCOS_CON_FECHA_MM_DD = ['qik'];

export class EmailParserService {

  /**
   * Verifica si el email es un pago de tarjeta (no un consumo)
   * Estos deben ser ignorados para evitar contar doble
   */
  static isPaymentEmail(subject: string, emailContent: string, incluirIngresos = false): boolean {
    const textToCheck = `${subject} ${emailContent}`.toLowerCase();

    if (PAYMENT_KEYWORDS.some(keyword => textToCheck.includes(keyword.toLowerCase()))) {
      return true;
    }

    // Con ingresos apagados, el dinero que entra se sigue descartando como antes
    return !incluirIngresos && INCOME_KEYWORDS.some(keyword => textToCheck.includes(keyword));
  }

  /**
   * ¿El ordenante es el mismo usuario? Una transferencia entre sus propias
   * cuentas (Popular → BHD) no es dinero nuevo: registrarla como ingreso le
   * infla los ingresos, y si la salida del otro banco entra como gasto, doble.
   *
   * Los bancos abrevian y cortan los nombres ("SRA ROSANNA M ELOY NUNEZ",
   * "ROSANNA MERCEDES ELOY NUNE"), así que se compara por palabras: hace falta
   * que coincida al menos un NOMBRE y al menos un APELLIDO del usuario. Un
   * familiar con el mismo apellido pero otro nombre sí cuenta como ingreso.
   */
  static isSelfTransfer(payerName?: string | null, userName?: string | null, userLastName?: string | null): boolean {
    const palabras = (s?: string | null): string[] =>
      (s || '')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toUpperCase()
        .replace(/[^A-Z\s]/g, ' ')
        .split(/\s+/)
        .filter(p => p && !HONORIFICOS.has(p));

    const ordenante = palabras(payerName);
    const nombres = palabras(userName);
    const apellidos = palabras(userLastName);
    if (ordenante.length === 0 || nombres.length === 0 || apellidos.length === 0) return false;

    // Igual, o cortada POR EL BANCO: la palabra del ordenante es el inicio de la
    // del usuario ("NUNE" → "NUNEZ", mínimo 4 letras). Nunca al revés: si no,
    // "JOSEFINA" o "MARIANA" (familiares) pasarían por "JOSE" o "MARIA".
    // Las iniciales ("M") no cuentan como coincidencia.
    const coincide = (delOrdenante: string, delUsuario: string): boolean =>
      delOrdenante === delUsuario ||
      (delOrdenante.length >= 4 && delUsuario.startsWith(delOrdenante));

    const completas = ordenante.filter(p => p.length > 1);
    const delUsuario = [...nombres, ...apellidos];
    const coincideNombre = completas.some(p => nombres.some(n => coincide(p, n)));
    const coincideApellido = completas.some(p => apellidos.some(a => coincide(p, a)));
    // Además, TODAS las palabras completas del ordenante tienen que ser del
    // usuario: "JOSE PEREZ ALONSO" no es "Jose Alonso Ochoa" aunque compartan
    // nombre y un apellido (con nombres tan comunes, sería perder un ingreso real).
    const todasSuyas = completas.every(p => delUsuario.some(u => coincide(p, u)));

    return coincideNombre && coincideApellido && todasSuyas;
  }

  /**
   * ¿La transacción NO se completó? (declinada, rechazada, sin fondos, reversada)
   * Estos correos traen comercio y monto igual que una compra real, así que sin
   * este filtro se registran como gasto y le inflan las cuentas al usuario.
   */
  static isDeclinedEmail(subject: string, emailContent: string): boolean {
    const textToCheck = `${subject} ${emailContent}`.toLowerCase();

    return DECLINED_KEYWORDS.some(keyword => textToCheck.includes(keyword));
  }

  /**
   * ¿Es un retiro de efectivo? (código cash, cajero, avance de efectivo)
   * No es un gasto: el dinero cambia de forma, no se consume. El gasto real lo
   * registra el usuario después, cuando compra algo con ese efectivo.
   */
  static isCashWithdrawalEmail(subject: string, emailContent: string): boolean {
    const subjectLower = (subject || '').toLowerCase();
    const textToCheck = `${subjectLower} ${(emailContent || '').toLowerCase()}`;

    if (CASH_WITHDRAWAL_KEYWORDS.some(keyword => textToCheck.includes(keyword))) {
      return true;
    }

    // Un "Depósito en cajero automático" menciona el cajero pero es dinero que
    // ENTRA: no es un retiro, que lo clasifique la IA.
    if (/dep[oó]sito/.test(subjectLower)) return false;

    // Genéricos: solo en el asunto, para no matchear pies de página publicitarios
    return CASH_WITHDRAWAL_SUBJECT_PATTERNS.some(pattern => pattern.test(subjectLower));
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
    userId?: string,
    opciones: ParseOptions = {}
  ): Promise<ParserResult> {
    const incluirIngresos = opciones.incluirIngresos === true;
    try {
      // Verificar si es un pago de tarjeta (no un consumo)
      if (this.isPaymentEmail(subject, emailContent, incluirIngresos)) {
        return {
          success: false,
          error: 'PAYMENT_EMAIL_SKIPPED: Este email es un pago de tarjeta, no un consumo'
        };
      }

      // Transacción que NO se completó: el dinero nunca salió de la cuenta.
      // Se descarta ANTES de llamar a la IA (determinista y sin costo de tokens).
      if (this.isDeclinedEmail(subject, emailContent)) {
        logger.log('[EmailParser] Email de transacción declinada/reversada, se omite');
        return {
          success: false,
          error: 'DECLINED_EMAIL_SKIPPED: La transacción no se completó (declinada, rechazada o reversada)'
        };
      }

      // Retiro de efectivo (código cash, cajero, avance): no es un gasto.
      // También va antes de la IA para que sea determinista: antes lo decidía
      // el modelo caso por caso y el mismo tipo de correo entraba a veces sí
      // y a veces no.
      if (this.isCashWithdrawalEmail(subject, emailContent)) {
        logger.log('[EmailParser] Email de retiro de efectivo, se omite');
        return {
          success: false,
          error: 'CASH_WITHDRAWAL_SKIPPED: Es un retiro de efectivo, no un consumo'
        };
      }

      // Obtener categorías de GASTOS de la base de datos
      // Solo categorías activas (isDefault: true); las canceladas (isDefault: false)
      // no se muestran en la app y NO deben ofrecerse a la IA.
      const expenseCategories = await prisma.category.findMany({
        where: { type: 'EXPENSE', isDefault: true },
        select: { name: true }
      });
      const categoryNames = expenseCategories.map(c => c.name);
      const categoryList = categoryNames.join(', ');

      logger.log(`[EmailParser] Using ${categoryNames.length} categories from DB: ${categoryList}`);

      // Categorías de INGRESO (solo con ingresos activados), mismo criterio de activas
      const incomeCategoryNames = incluirIngresos
        ? (await prisma.category.findMany({
            where: { type: 'INCOME', isDefault: true },
            select: { name: true }
          })).map(c => c.name)
        : [];
      const incomeCategoryList = incomeCategoryNames.join(', ');
      const incomeFallbackCategory = incomeCategoryNames.find(c =>
        c.toLowerCase().includes('otro')
      ) || incomeCategoryNames[0];

      const prompt = this.buildParserPrompt(
        emailContent, subject, bankName, categoryList,
        incluirIngresos ? incomeCategoryList : undefined
      );

      // Detectar categoría de fallback (Otros, Otros Gastos, etc.)
      const fallbackCategory = categoryNames.find(c =>
        c.toLowerCase().includes('otro')
      ) || categoryNames[0];

      const response = await openai.chat.completions.create({
        model: 'gpt-5.4-mini',
        messages: [
          {
            role: 'system',
            // Con ingresos activados cambia SOLO el encabezado (qué se extrae y
            // qué se ignora); las reglas de fecha y categorización de gastos son
            // las mismas. Apagado, el prompt es idéntico al de siempre.
            content: (incluirIngresos
              ? this.buildIncomeAwareHeader(incomeCategoryList, incomeFallbackCategory)
              : `Eres un experto en extraer datos de notificaciones bancarias de CONSUMOS y COMPRAS.

IMPORTANTE - DEBES IGNORAR estos tipos de emails (responde con is_payment_email: true):
- Pagos de tarjeta de credito (cuando el usuario PAGA su tarjeta)
- Abonos recibidos
- Confirmaciones de pago
- Transferencias recibidas
- Depositos
- TRANSACCIONES QUE NO SE COMPLETARON: declinadas, rechazadas, no autorizadas,
  fallidas, por fondos o limite insuficiente, reversadas o anuladas. Traen
  comercio y monto igual que una compra real, pero el dinero NUNCA salio de la
  cuenta: registrarlas le infla el gasto al usuario. Ante la duda de si una
  transaccion se completo o no, IGNORALA.
- RETIROS DE EFECTIVO: retiro de Codigo Cash, retiro sin tarjeta, retiro en
  cajero automatico / ATM, avance o adelanto de efectivo, disposicion de
  efectivo. Un retiro NO es un gasto: el dinero solo cambia de forma (de la
  cuenta al bolsillo). El gasto real lo registra el usuario despues, cuando
  compra algo con ese efectivo. Registrarlo aqui duplicaria el gasto.
  Si el correo describe un retiro o una entrega de efectivo, IGNORALO SIEMPRE,
  aunque traiga monto, fecha y numero de tarjeta.
- Cualquier email que NO sea un CONSUMO o COMPRA

Solo extrae datos de emails que sean CONSUMOS/COMPRAS/CARGOS (cuando el usuario GASTA dinero en un comercio).

Siempre responde UNICAMENTE con JSON valido, sin texto adicional.
Si el email es un pago/abono/deposito, responde: {"is_payment_email": true}
Si no puedes extraer algun dato, usa null.
El monto siempre debe ser un numero positivo.
La fecha debe estar en formato ISO 8601.
La moneda debe ser el codigo (RD$, USD, EUR, DOP).`) + `

IMPORTANTE - FORMATO DE FECHAS EN BANCOS DOMINICANOS:
Los bancos de República Dominicana usan formato DD/MM/YY (día/mes/año), NO MM/DD/YY.
Por ejemplo: "02/01/26" significa 2 de enero de 2026, NO 1 de febrero de 2026.
Asegúrate de interpretar las fechas correctamente antes de convertirlas a ISO 8601.

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
        max_completion_tokens: 500,
        response_format: { type: 'json_object' }
      });

      const content = response.choices[0]?.message?.content;

      // Log OpenAI usage
      if (userId) {
        const cost = calculateOpenAICost(
          'gpt-5.4-mini',
          response.usage?.prompt_tokens,
          response.usage?.completion_tokens
        );
        OpenAiUsageService.logUsageAsync({
          userId,
          feature: 'email_parser',
          model: 'gpt-5.4-mini',
          inputTokens: response.usage?.prompt_tokens,
          outputTokens: response.usage?.completion_tokens,
          status: 'success',
        });
      }

      if (!content) {
        return { success: false, error: 'No response from AI' };
      }

      const parsed = JSON.parse(content);

      // Si la AI detectó que es un pago de tarjeta, ignorar
      if (parsed.is_payment_email === true || (incluirIngresos && parsed.kind === 'IGNORE')) {
        logger.log(`[EmailParser] AI detected payment email, skipping: ${subject}`);
        return {
          success: false,
          error: 'PAYMENT_EMAIL_SKIPPED: AI detectó que es un pago de tarjeta, no un consumo'
        };
      }

      if (incluirIngresos && parsed.kind === 'INCOME') {
        return this.buildIncomeResult(parsed, content, opciones, incomeFallbackCategory);
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

            logger.log(`[EmailParser] Usando mapeo ${mapping.source} para "${merchant}" -> "${category}" (confianza: ${mapping.confidence}%)`);
          } else {
            logger.log(`[EmailParser] No hay mapeo para "${merchant}", usando categoría de IA: "${category}"`);
          }
        } catch (error) {
          logger.error('[EmailParser] Error buscando mapeo:', error);
          // Continuar con la categoría de la IA
        }
      }

      // ============================================
      // REGLAS DE COMERCIO CONOCIDO (deterministas)
      // Sobrescriben la categoría de la IA / mapeo global para comercios de
      // alto volumen (Uber Eats, PedidosYa, Uber). NO sobrescriben un mapeo
      // personal del usuario (si el usuario ya lo corrigió, su elección gana).
      // ============================================
      if (categorySource !== 'mapping_user') {
        const ruleCategory = this.applyKnownMerchantRules(merchant);
        if (ruleCategory) {
          if (ruleCategory !== category) {
            logger.log(`[EmailParser] Regla de comercio: "${merchant}" -> "${ruleCategory}" (antes: "${category}")`);
          }
          category = ruleCategory;
          categoryId = undefined; // resolver por nombre a la categoría activa (isDefault:true)
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
      logger.error('[EmailParserService] Parse error:', error);
      return {
        success: false,
        error: error.message || 'Unknown parsing error'
      };
    }
  }

  /**
   * Reglas deterministas para comercios conocidos de alto volumen.
   * Devuelve el NOMBRE de la categoría (que debe existir y estar activa) o null.
   * El ORDEN importa: las reglas específicas van ANTES que las genéricas,
   * para que "Uber Eats" no caiga en la regla genérica de "Uber" (Transporte).
   */
  private static applyKnownMerchantRules(merchant: string): string | null {
    const m = (merchant || '').toLowerCase();
    if (!m) return null;

    // PedidosYa Market = compra de supermercado (excepción antes de la genérica)
    if (m.includes('pedidosya') && m.includes('market')) return 'Supermercado';
    // PedidosYa (resto) = delivery de comida
    if (m.includes('pedidosya')) return 'Comida a domicilio';
    // Uber Eats = delivery de comida (ANTES que la regla genérica de Uber)
    if (m.includes('uber') && m.includes('eat')) return 'Comida a domicilio';
    // Uber (Rides, viajes, etc.) = transporte
    if (m.includes('uber')) return 'Transporte';

    return null;
  }

  /**
   * Encabezado del system prompt con ingresos activados: clasifica en
   * EXPENSE / INCOME / IGNORE en vez de "consumo o nada". Las reglas de fecha y
   * de categorización de gastos se le concatenan después, iguales que siempre.
   */
  private static buildIncomeAwareHeader(incomeCategoryList: string, incomeFallbackCategory?: string): string {
    return `Eres un experto en extraer datos de notificaciones bancarias. Clasificas cada correo en uno de tres tipos ("kind"):

- "EXPENSE": CONSUMOS/COMPRAS/CARGOS (cuando el usuario GASTA dinero en un comercio).
- "INCOME": dinero que ENTRA a una cuenta del usuario: transferencia recibida de otra persona o empresa, deposito (en sucursal, cajero o subagente), pago de nomina/salario, credito a la cuenta.
- "IGNORE": todo lo demas, en particular:
  - Pagos de tarjeta de credito (cuando el usuario PAGA su tarjeta) y abonos a la tarjeta. NO son ingresos: el dinero solo pasa de la cuenta a la tarjeta.
  - Confirmaciones de pago.
  - TRANSACCIONES QUE NO SE COMPLETARON: declinadas, rechazadas, no autorizadas,
    fallidas, por fondos o limite insuficiente, reversadas o anuladas. El dinero
    NUNCA se movio. Ante la duda de si una transaccion se completo o no, IGNORALA.
  - RETIROS DE EFECTIVO (codigo cash, cajero, avance de efectivo): el dinero solo
    cambia de forma. Si el correo describe un retiro, IGNORALO SIEMPRE.
  - Transferencias que el correo describe como ENTRE CUENTAS PROPIAS del usuario
    ("entre tus cuentas", "a cuenta propia"). No son dinero nuevo.
  - Transferencias ENVIADAS por el usuario a otra persona.
  - Avisos, promociones, estados de cuenta, cambios de clave.
Ante la duda entre INCOME e IGNORE, usa IGNORE.
Si es INCOME pero el correo NO dice el monto (por ejemplo, un aviso de deposito de nomina sin cifra), responde igual "kind": "INCOME" con "amount": null. NUNCA inventes ni estimes el monto.

Para INCOME:
- "payer_name": nombre de quien envia el dinero (el ordenante), tal como aparece. null si el correo no lo dice (los depositos en sucursal normalmente no lo dicen). NUNCA pongas el nombre del destinatario (a quien saluda el correo).
- "channel": TRANSFERENCIA | SUCURSAL | CAJERO | SUBAGENTE | NOMINA | OTRO
- "location": oficina, sucursal o cajero donde se hizo el deposito, o null.
- "origin_bank": banco de origen de la transferencia, o null.
- "merchant": null
- "cardLast4": null (el numero de la CUENTA no es una tarjeta).
- "category": DEBE ser exactamente una de estas categorias de ingreso: ${incomeCategoryList}. Si es nomina, salario o sueldo, usa la que corresponda a salario.${incomeFallbackCategory ? ` Si no estas seguro, usa "${incomeFallbackCategory}".` : ''}

Siempre responde UNICAMENTE con JSON valido, sin texto adicional.
Si el email es IGNORE, responde: {"kind": "IGNORE"}
Si no puedes extraer algun dato, usa null.
El monto siempre debe ser un numero positivo.
La fecha debe estar en formato ISO 8601.
La moneda debe ser el codigo (RD$, USD, EUR, DOP).

Las reglas de CATEGORIZACION de mas abajo aplican SOLO a EXPENSE.`;
  }

  /**
   * Arma el resultado de un INGRESO. No pasa por los mapeos ni las reglas de
   * comercio: esas son para gastos. La "descripción" (que se guarda en
   * `merchant`, igual que el comercio en un gasto) dice de dónde vino el dinero.
   */
  private static buildIncomeResult(
    parsed: any,
    rawContent: string,
    opciones: ParseOptions,
    incomeFallbackCategory?: string
  ): ParserResult {
    const payerName: string | undefined = typeof parsed.payer_name === 'string' && parsed.payer_name.trim()
      ? parsed.payer_name.trim()
      : undefined;

    if (this.isSelfTransfer(payerName, opciones.userName, opciones.userLastName)) {
      logger.log('[EmailParser] Transferencia entre cuentas propias, se omite');
      return {
        success: false,
        error: 'SELF_TRANSFER_SKIPPED: El ordenante es el mismo usuario (transferencia entre sus cuentas)'
      };
    }

    const canales: IncomeChannel[] = ['TRANSFERENCIA', 'SUCURSAL', 'CAJERO', 'SUBAGENTE', 'NOMINA', 'OTRO'];
    const canalIA = String(parsed.channel || '').toUpperCase() as IncomeChannel;
    const channel: IncomeChannel = canales.includes(canalIA) ? canalIA : 'OTRO';

    const location = typeof parsed.location === 'string' && parsed.location.trim()
      ? ` — ${this.toTitleCase(parsed.location.trim())}`
      : '';
    // Sin el tratamiento del banco: "Transferencia de Rosanna…", no "de Sra Rosanna…"
    const de = payerName
      ? this.toTitleCase(payerName.split(/\s+/).filter(p => !HONORIFICOS.has(p.replace(/\./g, '').toUpperCase())).join(' '))
      : '';

    const descripcionPorCanal: Record<IncomeChannel, string> = {
      TRANSFERENCIA: de ? `Transferencia de ${de}` : 'Transferencia recibida',
      NOMINA: de ? `Nómina ${de}` : 'Nómina',
      SUCURSAL: `Depósito en sucursal${location}`,
      CAJERO: `Depósito en cajero${location}`,
      SUBAGENTE: `Depósito en subagente${location}`,
      OTRO: de ? `Ingreso de ${de}` : 'Ingreso recibido',
    };

    // Hay bancos que avisan del ingreso SIN decir el monto (p. ej. "Depósito de
    // Nómina"). No se inventa un monto: se omite y la sincronización le avisa al
    // usuario para que lo registre él. Va DESPUÉS del filtro de transferencia
    // propia, que esas no merecen aviso.
    if (!parsed.amount || Number(parsed.amount) <= 0) {
      return {
        success: false,
        error: 'INCOME_NO_AMOUNT_SKIPPED: El banco avisó de un ingreso sin incluir el monto',
        rawResponse: rawContent,
        incomeWithoutAmount: { incomeChannel: channel, description: descripcionPorCanal[channel] }
      };
    }

    const transaction: ParsedTransaction = {
      type: 'INCOME',
      amount: Math.abs(Number(parsed.amount)),
      currency: this.normalizeCurrency(parsed.currency),
      merchant: descripcionPorCanal[channel],
      category: parsed.category || incomeFallbackCategory || '',
      date: parsed.date || new Date().toISOString(),
      description: parsed.description || undefined,
      confidence: this.calculateConfidence({ ...parsed, merchant: descripcionPorCanal[channel] }),
      categorySource: 'ai',
      payerName,
      incomeChannel: channel,
    };

    return { success: true, transaction };
  }

  /** "OFICINA AV JUAN PABLO DUARTE" → "Oficina Av Juan Pablo Duarte" */
  private static toTitleCase(s: string): string {
    return s.toLowerCase().replace(/(^|\s)(\p{L})/gu, (_m, sp, letra) => sp + letra.toUpperCase());
  }

  /**
   * Construye el prompt para el parser
   */
  private static buildParserPrompt(
    emailContent: string,
    subject: string,
    bankName?: string,
    categoryList?: string,
    incomeCategoryList?: string  // solo con ingresos activados
  ): string {
    // categoryList siempre viene de la DB, no debería ser undefined
    if (!categoryList) {
      throw new Error('No categories provided - must query from database first');
    }

    // El system prompt fija DD/MM para toda RD. Los bancos de esta lista van al
    // revés y hay que decírselo al modelo, si no "09-07-2026" (7 de septiembre)
    // se guarda como 9 de julio.
    const formatoFecha = bankName && BANCOS_CON_FECHA_MM_DD.some(b => bankName.toLowerCase().includes(b))
      ? `

ATENCION: ${bankName} escribe las fechas en formato MM-DD-YYYY (mes-dia-año), al reves que los demas bancos dominicanos. Ejemplo: "09-07-2026 09:14 PM" es el 7 de septiembre de 2026, NO el 9 de julio.`
      : '';

    if (incomeCategoryList !== undefined) {
      return `Clasifica y extrae la informacion de esta notificacion bancaria${bankName ? ` de ${bankName}` : ''}:${formatoFecha}

ASUNTO: ${subject}

CONTENIDO:
${emailContent.substring(0, 3000)}

Responde SOLO con este JSON:
{
  "kind": "<EXPENSE|INCOME|IGNORE>",
  "amount": <numero positivo>,
  "currency": "<RD$|USD|EUR|DOP>",
  "merchant": "<si EXPENSE: nombre del comercio/establecimiento; si INCOME: null>",
  "category": "<si EXPENSE: exactamente una de: ${categoryList}. Si INCOME: exactamente una de: ${incomeCategoryList}>",
  "date": "<fecha ISO 8601>",
  "cardLast4": "<si EXPENSE: ultimos 4 digitos de tarjeta o null; si INCOME: null>",
  "authorizationCode": "<codigo de autorizacion o null>",
  "description": "<descripcion adicional o null>",
  "payer_name": "<si INCOME: nombre del ordenante o null>",
  "channel": "<si INCOME: TRANSFERENCIA|SUCURSAL|CAJERO|SUBAGENTE|NOMINA|OTRO>",
  "location": "<si INCOME: oficina/sucursal/cajero del deposito o null>",
  "origin_bank": "<si INCOME: banco de origen o null>"
}`;
    }

    return `Extrae la informacion de esta notificacion bancaria${bankName ? ` de ${bankName}` : ''}:${formatoFecha}

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
  static async findCategoryByName(categoryName: string, type: 'EXPENSE' | 'INCOME' = 'EXPENSE'): Promise<string | null> {
    const category = await prisma.category.findFirst({
      where: {
        name: {
          contains: categoryName,
          mode: 'insensitive'
        },
        type,
        isDefault: true // no resolver a categorías canceladas
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
        type: 'EXPENSE',
        isDefault: true // solo categorías activas
      }
    });

    if (otrosCategory) return otrosCategory.id;

    // Si no existe, buscar cualquier categoria de gasto activa
    const anyCategory = await prisma.category.findFirst({
      where: { type: 'EXPENSE', isDefault: true }
    });

    return anyCategory?.id || '';
  }

  /**
   * Categoría por defecto para ingresos: la de "Otros ingresos" o, si no
   * existe, cualquier categoría de ingreso activa.
   */
  static async getDefaultIncomeCategory(): Promise<string> {
    const otrosCategory = await prisma.category.findFirst({
      where: {
        name: { contains: 'otro', mode: 'insensitive' },
        type: 'INCOME',
        isDefault: true
      }
    });

    if (otrosCategory) return otrosCategory.id;

    const anyCategory = await prisma.category.findFirst({
      where: { type: 'INCOME', isDefault: true }
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
    merchant?: string,
    type: 'EXPENSE' | 'INCOME' = 'EXPENSE',
    currency?: string
  ): Promise<boolean> {
    const transactionDate = new Date(date);
    const startDate = new Date(transactionDate);
    startDate.setHours(0, 0, 0, 0);
    const endDate = new Date(transactionDate);
    endDate.setHours(23, 59, 59, 999);

    // En moneda extranjera la transacción se guarda convertida a RD$, así que
    // comparar `amount` contra el monto del correo (US$250 vs RD$15,130.80)
    // nunca coincidía y el segundo aviso del banco entraba duplicado. En ese
    // caso se busca el monto original en la etiqueta de conversión que
    // createTransactionFromParsed pone en la descripción ("[USD 250 → ...").
    const moneda = ExchangeRateService.normalizeCurrency(currency || '');
    const extranjera = moneda !== 'DOP';

    const existing = await prisma.transaction.findFirst({
      where: {
        userId,
        ...(!extranjera && { amount }),
        date: {
          gte: startDate,
          lte: endDate
        },
        type,
        AND: [
          ...(merchant ? [{ description: { contains: merchant, mode: 'insensitive' as const } }] : []),
          ...(extranjera ? [{ description: { contains: `[${moneda} ${amount} →` } }] : [])
        ]
      }
    });

    return !!existing;
  }
}

export default EmailParserService;
