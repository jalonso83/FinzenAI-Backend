/**
 * OpenAI Pricing Configuration
 * Precios actualizados a abril 2026
 * Referencia: https://openai.com/pricing
 */

export const OPENAI_PRICING = {
  'gpt-5.4-mini': {
    inputTokens: 0.75 / 1_000_000, // $0.75 por 1M tokens
    outputTokens: 0.075 / 1_000_000, // $0.075 por 1M tokens
  },
  'gpt-4o-mini': {
    inputTokens: 0.15 / 1_000_000,
    outputTokens: 0.6 / 1_000_000,
  },
  'gpt-4o': {
    inputTokens: 2.5 / 1_000_000,
    outputTokens: 10 / 1_000_000,
  },
  'whisper-1': {
    // $0.02 por minuto de audio
    perMinute: 0.02,
  },
  'gpt-4o-mini-tts': {
    // $0.015 por 1000 caracteres
    perCharacter: 0.015 / 1_000,
  },
} as const;

/**
 * Calcula el costo en USD basado en el modelo y tokens/duración
 */
export function calculateOpenAICost(
  model: string,
  inputTokens?: number,
  outputTokens?: number,
  durationMinutes?: number,
  characters?: number
): number {
  const pricing = OPENAI_PRICING[model as keyof typeof OPENAI_PRICING];

  if (!pricing) {
    console.warn(`[OpenAI Pricing] Modelo desconocido: ${model}`);
    return 0;
  }

  let cost = 0;

  // Chat completions (gpt-5.4-mini, gpt-4o-mini, gpt-4o)
  if ('inputTokens' in pricing && 'outputTokens' in pricing) {
    const inputCost = (inputTokens || 0) * pricing.inputTokens;
    const outputCost = (outputTokens || 0) * pricing.outputTokens;
    cost = inputCost + outputCost;
  }

  // Whisper (por minuto)
  if (model === 'whisper-1' && durationMinutes !== undefined) {
    cost = durationMinutes * pricing.perMinute;
  }

  // TTS (por carácter)
  if (model === 'gpt-4o-mini-tts' && characters !== undefined) {
    cost = characters * pricing.perCharacter;
  }

  // Redondear a 8 decimales (máxima precisión)
  return Math.round(cost * 100_000_000) / 100_000_000;
}
