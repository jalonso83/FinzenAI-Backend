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
import { prisma } from '../lib/prisma';

const router: RouterType = Router();

/**
 * POST /api/tts/generate
 * Body: { text: string }
 * Response: audio/mpeg (binary)
 */
router.post('/generate', apiLimiter, authenticateToken, async (req: Request, res: Response) => {
  try {
    const { text } = req.body;
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'No authenticated user' });
    }

    if (!text || text.trim().length === 0) {
      return res.status(400).json({ error: 'Texto requerido' });
    }

    if (text.length > 5000) {
      return res.status(400).json({ error: 'Texto demasiado largo (máximo 5000 caracteres)' });
    }

    if (!openAiTtsService.isAvailable()) {
      return res.status(503).json({ error: 'Servicio TTS no disponible' });
    }

    // Obtener moneda del usuario
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { currency: true },
    });

    const currency = user?.currency || 'usd';

    const result = await openAiTtsService.generateSpeech({ text, currency });

    if (!result.success || !result.audio) {
      return res.status(500).json({ error: result.error || 'Error generando audio' });
    }

    // Si el cliente pide base64 (más confiable en iOS), devolver JSON
    if (req.body.format === 'base64') {
      return res.json({
        success: true,
        audio: result.audio.toString('base64'),
        contentType: 'audio/mpeg',
      });
    }

    res.set({
      'Content-Type': 'audio/mpeg',
      'Content-Length': result.audio.length.toString(),
      'Cache-Control': 'no-cache',
    });

    return res.send(result.audio);

  } catch (error: any) {
    logger.error('TTS generation error:', error.message);
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
