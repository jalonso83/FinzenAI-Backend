/**
 * OpenAI TTS Service
 * Genera audio de alta calidad usando gpt-4o-mini-tts de OpenAI.
 * Reemplaza ElevenLabs — mismo proveedor que Zenio, mismo billing.
 */

import { ENV } from '../config/env';
import { logger } from '../utils/logger';
import { OpenAiUsageService } from './openAiUsageService';
import { calculateOpenAICost } from '../config/openaiPricing';

const OPENAI_TTS_URL = 'https://api.openai.com/v1/audio/speech';

interface TTSOptions {
  text: string;
  voice?: string;
  currency?: string;
  userId?: string; // Para logging de uso
}

// Mapeo de monedas a sus abreviaturas y nombres en español
const CURRENCY_MAP: Record<string, { abbr: string; fullName: string }> = {
  'dop': { abbr: 'RD', fullName: 'pesos dominicanos' },
  'do': { abbr: 'RD', fullName: 'pesos dominicanos' },
  'usd': { abbr: 'USD', fullName: 'dólares' },
  'mxn': { abbr: 'MXN', fullName: 'pesos mexicanos' },
  'mx': { abbr: 'MXN', fullName: 'pesos mexicanos' },
  'ars': { abbr: 'ARS', fullName: 'pesos argentinos' },
  'ar': { abbr: 'ARS', fullName: 'pesos argentinos' },
  'clp': { abbr: 'CLP', fullName: 'pesos chilenos' },
  'cl': { abbr: 'CLP', fullName: 'pesos chilenos' },
  'cop': { abbr: 'COP', fullName: 'pesos colombianos' },
  'co': { abbr: 'COP', fullName: 'pesos colombianos' },
  'eur': { abbr: 'EUR', fullName: 'euros' },
  'gbp': { abbr: 'GBP', fullName: 'libras esterlinas' },
  'jpy': { abbr: 'JPY', fullName: 'yenes' },
  'cad': { abbr: 'CAD', fullName: 'dólares canadienses' },
  'aud': { abbr: 'AUD', fullName: 'dólares australianos' },
  'brr': { abbr: 'BRL', fullName: 'reales brasileños' },
  'br': { abbr: 'BRL', fullName: 'reales brasileños' },
  'pe': { abbr: 'PEN', fullName: 'soles peruanos' },
  'pen': { abbr: 'PEN', fullName: 'soles peruanos' },
  've': { abbr: 'VES', fullName: 'bolívares' },
  'ves': { abbr: 'VES', fullName: 'bolívares' },
};

interface TTSResult {
  success: boolean;
  audio?: Buffer;
  contentType?: string;
  error?: string;
}

class OpenAiTtsService {

  private get apiKey(): string {
    return ENV.OPENAI_API_KEY;
  }

  /**
   * Verifica si el servicio está disponible
   */
  isAvailable(): boolean {
    return !!this.apiKey && this.apiKey.length > 0;
  }

  /**
   * Genera audio a partir de texto
   * Retorna un Buffer con el audio en formato MP3
   */
  async generateSpeech(options: TTSOptions): Promise<TTSResult> {
    if (!this.isAvailable()) {
      return { success: false, error: 'OpenAI API key no configurada' };
    }

    const {
      text,
      voice = 'fable',
      currency = 'usd',
      userId,
    } = options;

    if (!text || text.trim().length === 0) {
      return { success: false, error: 'Texto vacío' };
    }

    const cleanText = this.cleanTextForSpeech(text, currency.toLowerCase());

    if (cleanText.length === 0) {
      return { success: false, error: 'Texto vacío después de limpieza' };
    }

    try {
      logger.log(`[OpenAI TTS] Generando audio (${voice}): ${cleanText.substring(0, 80)}... (${cleanText.length} chars)`);

      const response = await fetch(OPENAI_TTS_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini-tts',
          voice,
          input: cleanText,
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        logger.error(`[OpenAI TTS] Error API: ${response.status} ${errorBody}`);
        return {
          success: false,
          error: `OpenAI TTS error: ${response.status}`,
        };
      }

      const arrayBuffer = await response.arrayBuffer();
      const audio = Buffer.from(arrayBuffer);

      logger.log(`[OpenAI TTS] Audio generado: ${audio.length} bytes`);

      // Log OpenAI usage - TTS se cobra por caracteres
      if (userId) {
        const cost = calculateOpenAICost('gpt-4o-mini-tts', undefined, undefined, undefined, cleanText.length);
        OpenAiUsageService.logUsageAsync({
          userId,
          feature: 'tts',
          model: 'gpt-4o-mini-tts',
          characters: cleanText.length,
          status: 'success',
        });
      }

      return {
        success: true,
        audio,
        contentType: 'audio/mpeg',
      };

    } catch (error: any) {
      logger.error('[OpenAI TTS] Error:', error.message);
      return {
        success: false,
        error: error.message || 'Error generando audio',
      };
    }
  }

  /**
   * Limpia el texto para que suene bien en TTS
   */
  private cleanTextForSpeech(text: string, currency: string = 'usd'): string {
    let clean = text;

    // Expandir abreviaturas monetarias según la moneda del usuario
    const currencyInfo = CURRENCY_MAP[currency] || CURRENCY_MAP['usd'];
    const currencyFullName = currencyInfo.fullName;
    const currencyAbbr = currencyInfo.abbr;

    // Expandir la moneda principal del usuario (orden importa: específico primero)
    // Formato: RD$2000 o RD$ 2000
    clean = clean.replace(new RegExp(`${currencyAbbr}\\$\\s*(\\d+)`, 'gi'), `${currencyFullName} $1`);
    // Formato: RD 2000 o RD2000
    clean = clean.replace(new RegExp(`${currencyAbbr}\\s*(\\d+)`, 'gi'), `${currencyFullName} $1`);
    // Formato: 2000 RD o 2000RD
    clean = clean.replace(new RegExp(`(\\d+)\\s*${currencyAbbr}\\b`, 'gi'), `$1 ${currencyFullName}`);
    // Solo $ (sin moneda): $2000
    clean = clean.replace(new RegExp(`\\$\\s*(\\d+)`, 'gi'), `${currencyFullName} $1`);
    // RD solo (sin número)
    clean = clean.replace(new RegExp(`\\b${currencyAbbr}\\b`, 'gi'), currencyFullName);

    // Expandir otras monedas comunes internacionales
    clean = clean.replace(/\bUSD\b/gi, 'dólares estadounidenses');
    clean = clean.replace(/\bUSD\s*(\d+)/gi, 'dólares estadounidenses $1');
    clean = clean.replace(/(\d+)\s*USD\b/gi, '$1 dólares estadounidenses');

    clean = clean.replace(/\bEUR\b/gi, 'euros');
    clean = clean.replace(/\bEUR\s*(\d+)/gi, 'euros $1');
    clean = clean.replace(/(\d+)\s*EUR\b/gi, '$1 euros');

    clean = clean.replace(/\bGBP\b/gi, 'libras esterlinas');
    clean = clean.replace(/\bMXN\b/gi, 'pesos mexicanos');
    clean = clean.replace(/\bARS\b/gi, 'pesos argentinos');
    clean = clean.replace(/\bCOP\b/gi, 'pesos colombianos');
    clean = clean.replace(/\bBRL\b/gi, 'reales brasileños');
    clean = clean.replace(/\bJPY\b/gi, 'yenes');

    // Quitar markdown headers
    clean = clean.replace(/#{1,6}\s*/g, '');

    // Quitar bold/italic
    clean = clean.replace(/\*\*([^*]+)\*\*/g, '$1');
    clean = clean.replace(/\*([^*]+)\*/g, '$1');
    clean = clean.replace(/__([^_]+)__/g, '$1');
    clean = clean.replace(/_([^_]+)_/g, '$1');

    // Quitar bullets y listas
    clean = clean.replace(/^[\s]*[-·•]\s*/gm, '');
    clean = clean.replace(/^[\s]*\d+\.\s*/gm, '');

    // Quitar emojis
    clean = clean.replace(/[\u{1F600}-\u{1F64F}]/gu, '');
    clean = clean.replace(/[\u{1F300}-\u{1F5FF}]/gu, '');
    clean = clean.replace(/[\u{1F680}-\u{1F6FF}]/gu, '');
    clean = clean.replace(/[\u{1F900}-\u{1F9FF}]/gu, '');
    clean = clean.replace(/[\u{2600}-\u{26FF}]/gu, '');
    clean = clean.replace(/[\u{2700}-\u{27BF}]/gu, '');
    clean = clean.replace(/[\u{FE00}-\u{FE0F}]/gu, '');
    clean = clean.replace(/[\u{1FA00}-\u{1FA6F}]/gu, '');
    clean = clean.replace(/[\u{1FA70}-\u{1FAFF}]/gu, '');
    clean = clean.replace(/[\u{200D}]/gu, '');
    clean = clean.replace(/📋|📊|🟢|🟡|🔴|✅|❌|⚠️|👋|🎉/g, '');

    // Quitar la firma de Zenio
    clean = clean.replace(/—\s*Zenio,?\s*tu copiloto financiero\.?/gi, '');

    // Quitar URLs
    clean = clean.replace(/https?:\/\/[^\s]+/g, '');

    // Quitar líneas vacías múltiples
    clean = clean.replace(/\n{3,}/g, '\n\n');

    // Trim
    clean = clean.trim();

    return clean;
  }
}

export const openAiTtsService = new OpenAiTtsService();
