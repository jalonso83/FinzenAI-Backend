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
  const platform = req.headers['x-platform'] || req.headers['user-agent'] || 'desconocido';
  const userId = req.user?.id || 'unknown';
  logger.error(`[TTS] Solicitud recibida | usuario: ${userId} | plataforma: ${platform} | texto: ${(req.body?.text || '').substring(0, 60)}...`);

  try {
    const { text } = req.body;

    if (!text || text.trim().length === 0) {
      logger.error(`[TTS] RECHAZADO: texto vacío | usuario: ${userId}`);
      return res.status(400).json({ error: 'Texto requerido' });
    }

    if (text.length > 5000) {
      logger.error(`[TTS] RECHAZADO: texto largo (${text.length} chars) | usuario: ${userId}`);
      return res.status(400).json({ error: 'Texto demasiado largo (máximo 5000 caracteres)' });
    }

    if (!openAiTtsService.isAvailable()) {
      logger.error(`[TTS] FALLO: servicio no disponible (API key?) | usuario: ${userId}`);
      return res.status(503).json({ error: 'Servicio TTS no disponible' });
    }

    const result = await openAiTtsService.generateSpeech({ text });

    if (!result.success || !result.audio) {
      logger.error(`[TTS] FALLO: OpenAI no generó audio | usuario: ${userId} | error: ${result.error}`);
      return res.status(500).json({ error: result.error || 'Error generando audio' });
    }

    logger.error(`[TTS] OK: audio generado ${result.audio.length} bytes | usuario: ${userId}`);

    res.set({
      'Content-Type': 'audio/mpeg',
      'Content-Length': result.audio.length.toString(),
      'Cache-Control': 'no-cache',
    });

    return res.send(result.audio);

  } catch (error: any) {
    logger.error(`[TTS] ERROR INTERNO: ${error.message} | usuario: ${userId}`);
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
