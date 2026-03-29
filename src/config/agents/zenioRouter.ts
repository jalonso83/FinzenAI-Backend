/**
 * Zenio Router — Clasificador de intención basado en reglas
 * No usa LLM, clasifica por patrones en el mensaje del usuario
 * Determina qué agente especializado debe responder
 */

export type AgentType = 'asistente' | 'educativo';

// Patrones para detectar intención operativa (ASISTENTE)
const OPERATION_PATTERNS = [
  // Transacciones
  /\b(gast[éeao]|ingres[éeao]|cobr[éeao]|pagu[ée]|compr[ée]|pag[ué])\b/i,
  /\b(registr|anot|agreg|cre[ao]|elimin|borr|actualiz|modific|edit)\w*\b/i,
  /\b(transacci[oó]n|gasto|ingreso)\b/i,
  // Presupuestos
  /\b(presupuesto)\b/i,
  // Metas
  /\b(meta|objetivo)\s+(de\s+)?(ahorro|pago|inversión|retiro|emergencia|deuda)/i,
  /\b(crear|nueva|agregar|eliminar|borrar|actualizar|modificar)\s+(una?\s+)?(meta|presupuesto|transacci[oó]n|gasto|ingreso)/i,
  // Montos directos (señal fuerte de operación)
  /\bRD\$[\d,.]+/i,
  /\b\d+\s*(mil|pesos|dolares)\b/i,
  // Listar/consultar datos propios
  /\b(cu[aá]nto|cu[aá]les|mis|lista|listar|ver|muestra|mostrar)\s+(gasto|ingreso|meta|presupuesto|transacci[oó]n)/i,
  // Categorías
  /\b(categor[ií]a)/i,
  // Gastos hormiga (redirección, pero el Asistente la maneja)
  /\b(gastos?\s+hormiga|detective|peque[ñn]os\s+gastos|donde\s+se\s+va\s+mi\s+dinero)/i,
];

// Patrones para detectar intención educativa (EDUCATIVO)
const EDUCATION_PATTERNS = [
  // Preguntas conceptuales
  /\b(qu[ée]\s+(es|son|significa)|c[oó]mo\s+funciona|expl[ií]c(ame|a)|ense[ñn]a|aprend)/i,
  /\b(qu[ée]\s+me\s+recomiend|consejo|sugerencia|tip|estrategia|t[ée]cnica)/i,
  // Temas educativos específicos
  /\b(inter[ée]s\s+compuesto|inflaci[oó]n|diversific|portafolio|inversi[oó]n|invertir)\b/i,
  /\b(retiro|jubilaci[oó]n|AFP|pensi[oó]n|fideicomiso)\b/i,
  /\b(impuesto|DGII|fiscal|tributar|deducci[oó]n)\b/i,
  /\b(seguro|p[oó]liza|cobertura|prima|deducible)\b/i,
  /\b(cripto|bitcoin|blockchain|ethereum|token|DeFi)\b/i,
  /\b(trading|broker|acci[oó]n|bono|fondo\s+indexado|ETF)\b/i,
  /\b(cr[ée]dito|score|historial\s+credit|DataCr[ée]dito)\b/i,
  /\b(50.30.20|bola\s+de\s+nieve|avalancha|SMART)\b/i,
  /\b(tarjeta\s+de\s+cr[ée]dito|APR|tasa\s+de\s+inter[ée]s|comisi[oó]n)\b/i,
  // Preguntas abiertas sobre finanzas
  /\b(c[oó]mo\s+(ahorr|invert|pag|manejar|mejora|reduc|aument))/i,
  /\b(por\s+qu[ée]\s+(es\s+importante|deber[ií]a|conviene))/i,
  /\b(diferencia\s+entre|ventajas?\s+de|desventajas?\s+de)/i,
  // Principios financieros
  /\b(principio|regla|ley)\s+(financier|de\s+oro|b[aá]sic)/i,
  /\b(p[aá]gate\s+primero|fondo\s+de\s+emergencia|presupuesto\s+base\s+cero)/i,
];

/**
 * Clasifica la intención del mensaje del usuario
 * Retorna el tipo de agente que debe responder
 */
export function classifyIntent(message: string): AgentType {
  if (!message || message.trim().length === 0) return 'asistente';

  const msg = message.toLowerCase().trim();

  // Contar matches en cada categoría
  let operationScore = 0;
  let educationScore = 0;

  for (const pattern of OPERATION_PATTERNS) {
    if (pattern.test(msg)) operationScore++;
  }

  for (const pattern of EDUCATION_PATTERNS) {
    if (pattern.test(msg)) educationScore++;
  }

  // Si hay señales operativas claras (monto + acción), priorizar Asistente
  if (operationScore > 0 && /\d/.test(msg)) return 'asistente';

  // Si solo hay señales educativas, enviar a Educativo
  if (educationScore > 0 && operationScore === 0) return 'educativo';

  // Si hay ambas, el que tenga más score gana
  if (educationScore > operationScore) return 'educativo';

  // Default: Asistente (el más versátil)
  return 'asistente';
}
