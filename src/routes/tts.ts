/**
 * Ruta de Text-to-Speech con OpenAI (gpt-4o-mini-tts, voz fable)
 * POST /api/tts/generate — genera audio a partir de texto
 */

import { Router, type Router as RouterType } from 'express';
import { Request, Response } from 'express';
import { authenticateToken } from '../middlewares/auth';
import { apiLimiter } from '../config/rateLimiter';
import { openAiTtsService } from '../services/openAiTtsService';
import { logger } from '../utils/logger';

const router: RouterType = Router();

/**
 * POST /api/tts/generate
 * Body: { text: string }
 * Response: audio/mpeg (binary)
 */
router.post('/generate', apiLimiter, authenticateToken, async (req: Request, res: Response) => {
  try {
    const { text } = req.body;

    if (!text || text.trim().length === 0) {
      return res.status(400).json({ error: 'Texto requerido' });
    }

    if (text.length > 5000) {
      return res.status(400).json({ error: 'Texto demasiado largo (máximo 5000 caracteres)' });
    }

    if (!openAiTtsService.isAvailable()) {
      return res.status(503).json({ error: 'Servicio TTS no disponible' });
    }

    const result = await openAiTtsService.generateSpeech({ text });

    if (!result.success || !result.audio) {
      return res.status(500).json({ error: result.error || 'Error generando audio' });
    }

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
 */
router.get('/status', authenticateToken, async (_req: Request, res: Response) => {
  return res.json({
    available: openAiTtsService.isAvailable(),
    provider: 'openai',
    voice: 'fable',
  });
});

export default router;
