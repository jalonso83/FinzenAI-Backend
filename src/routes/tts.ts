/**
 * Ruta de Text-to-Speech con ElevenLabs
 * POST /api/tts/generate — genera audio a partir de texto
 *
 * Independiente del TTS nativo (expo-speech).
 * La app puede usar este endpoint cuando se active el switch.
 */

import { Router, type Router as RouterType } from 'express';
import { Request, Response } from 'express';
import { authenticateToken } from '../middlewares/auth';
import { apiLimiter } from '../config/rateLimiter';
import { elevenLabsService } from '../services/elevenLabsService';
import { logger } from '../utils/logger';

const router: RouterType = Router();

/**
 * POST /api/tts/generate
 * Body: { text: string, voiceId?: string }
 * Response: audio/mpeg (binary)
 */
router.post('/generate', apiLimiter, authenticateToken, async (req: Request, res: Response) => {
  try {
    const { text, voiceId } = req.body;

    if (!text || text.trim().length === 0) {
      return res.status(400).json({ error: 'Texto requerido' });
    }

    // Límite de caracteres para evitar abuso
    if (text.length > 5000) {
      return res.status(400).json({ error: 'Texto demasiado largo (máximo 5000 caracteres)' });
    }

    if (!elevenLabsService.isAvailable()) {
      return res.status(503).json({ error: 'Servicio TTS no disponible' });
    }

    const result = await elevenLabsService.generateSpeech({
      text,
      voiceId,
    });

    if (!result.success || !result.audio) {
      return res.status(500).json({ error: result.error || 'Error generando audio' });
    }

    // Enviar audio como binario
    res.set({
      'Content-Type': 'audio/mpeg',
      'Content-Length': result.audio.length.toString(),
      'Cache-Control': 'no-cache',
    });

    return res.send(result.audio);

  } catch (error: any) {
    logger.error('[TTS] Error:', error.message);
    return res.status(500).json({ error: 'Error interno del servicio TTS' });
  }
});

/**
 * GET /api/tts/status
 * Verifica si ElevenLabs está configurado
 */
router.get('/status', authenticateToken, async (_req: Request, res: Response) => {
  return res.json({
    available: elevenLabsService.isAvailable(),
    provider: 'elevenlabs',
  });
});

export default router;
