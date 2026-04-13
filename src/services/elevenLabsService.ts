/**
 * ElevenLabs TTS Service
 * Genera audio de alta calidad a partir de texto usando la API de ElevenLabs.
 * Se usa como alternativa al TTS nativo del dispositivo (expo-speech).
 *
 * Independiente del TTS actual — se activa por endpoint separado.
 */

import { ENV } from '../config/env';
import { logger } from '../utils/logger';

const ELEVENLABS_API_URL = 'https://api.elevenlabs.io/v1';

interface TTSOptions {
  text: string;
  voiceId?: string;
  modelId?: string;
  stability?: number;      // 0-1: más alto = más consistente, más bajo = más expresivo
  similarityBoost?: number; // 0-1: qué tan parecido al original
  style?: number;          // 0-1: exageración del estilo
  speakerBoost?: boolean;  // mejora la claridad del hablante
}

interface TTSResult {
  success: boolean;
  audio?: Buffer;
  contentType?: string;
  error?: string;
}

class ElevenLabsService {

  private get apiKey(): string {
    return ENV.ELEVENLABS_API_KEY;
  }

  private get defaultVoiceId(): string {
    return ENV.ELEVENLABS_VOICE_ID;
  }

  /**
   * Verifica si ElevenLabs está configurado y disponible
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
      return { success: false, error: 'ElevenLabs API key no configurada' };
    }

    const {
      text,
      voiceId = this.defaultVoiceId,
      modelId = 'eleven_multilingual_v2',
      stability = 0.5,
      similarityBoost = 0.75,
      style = 0.0,
      speakerBoost = true,
    } = options;

    if (!text || text.trim().length === 0) {
      return { success: false, error: 'Texto vacío' };
    }

    // Limpiar texto para TTS (quitar markdown, emojis excesivos, etc.)
    const cleanText = this.cleanTextForSpeech(text);

    if (cleanText.length === 0) {
      return { success: false, error: 'Texto vacío después de limpieza' };
    }

    try {
      logger.log(`[ElevenLabs] Generando audio: ${cleanText.substring(0, 80)}... (${cleanText.length} chars)`);

      const response = await fetch(`${ELEVENLABS_API_URL}/text-to-speech/${voiceId}`, {
        method: 'POST',
        headers: {
          'Accept': 'audio/mpeg',
          'Content-Type': 'application/json',
          'xi-api-key': this.apiKey,
        },
        body: JSON.stringify({
          text: cleanText,
          model_id: modelId,
          voice_settings: {
            stability,
            similarity_boost: similarityBoost,
            style,
            use_speaker_boost: speakerBoost,
          },
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        logger.error(`[ElevenLabs] Error API: ${response.status} ${errorBody}`);
        return {
          success: false,
          error: `ElevenLabs API error: ${response.status}`,
        };
      }

      const arrayBuffer = await response.arrayBuffer();
      const audio = Buffer.from(arrayBuffer);

      logger.log(`[ElevenLabs] Audio generado: ${audio.length} bytes`);

      return {
        success: true,
        audio,
        contentType: 'audio/mpeg',
      };

    } catch (error: any) {
      logger.error('[ElevenLabs] Error:', error.message);
      return {
        success: false,
        error: error.message || 'Error generando audio',
      };
    }
  }

  /**
   * Limpia el texto para que suene bien en TTS
   * Quita markdown, emojis, formato, etc.
   */
  private cleanTextForSpeech(text: string): string {
    let clean = text;

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

    // Quitar emojis (la mayoría)
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

    // Quitar la firma de Zenio (no tiene sentido hablarla)
    clean = clean.replace(/—\s*Zenio,?\s*tu copiloto financiero\.?/gi, '');

    // Quitar URLs
    clean = clean.replace(/https?:\/\/[^\s]+/g, '');

    // Quitar líneas vacías múltiples
    clean = clean.replace(/\n{3,}/g, '\n\n');

    // Reemplazar "RD$" por "pesos" para que se pronuncie bien
    clean = clean.replace(/RD\$\s*([\d,.]+)/g, '$1 pesos');

    // Trim
    clean = clean.trim();

    return clean;
  }
}

export const elevenLabsService = new ElevenLabsService();
