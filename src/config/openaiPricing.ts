/**
 * OpenAI Pricing Configuration
 * Precios actualizados a abril 2026
 * Referencia: https://openai.com/pricing (2026-04-23)
 */

export const OPENAI_PRICING = {
  'gpt-5.4': {
    inputTokens: 2.5 / 1_000_000,
    outputTokens: 15 / 1_000_000,
  },
  'gpt-5.4-mini': {
    inputTokens: 0.75 / 1_000_000,
    outputTokens: 4.5 / 1_000_000,
  },
  'gpt-5.4-nano': {
    inputTokens: 0.2 / 1_000_000,
    outputTokens: 1.25 / 1_000_000,
  },
  'gpt-4o-mini': {
    inputTokens: 0.15 / 1_000_000,
    outputTokens: 0.6 / 1_000_000,
  },
  'gpt-4o': {
    inputTokens: 2.5 / 1_000_000,
    outputTokens: 10 / 1_000_000,
  },
  'gpt-4o-mini-transcribe': {
    // $0.003 por minuto de audio (aproximadamente)
    perMinute: 0.003,
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
    const p = pricing as { inputTokens: number; outputTokens: number };
    const inputCost = (inputTokens || 0) * p.inputTokens;
    const outputCost = (outputTokens || 0) * p.outputTokens;
    cost = inputCost + outputCost;
  }

  // Whisper (por minuto)
  if (model === 'whisper-1' && durationMinutes !== undefined) {
    const p = pricing as { perMinute: number };
    cost = durationMinutes * p.perMinute;
  }

  // TTS (por carácter)
  if (model === 'gpt-4o-mini-tts' && characters !== undefined) {
    const p = pricing as { perCharacter: number };
    cost = characters * p.perCharacter;
  }

  // Redondear a 8 decimales (máxima precisión)
  return Math.round(cost * 100_000_000) / 100_000_000;
}
