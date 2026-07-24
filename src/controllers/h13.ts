import type { Request, Response } from 'express';
import { logger } from '../utils/logger';
import {
  getH13State,
  respondOffer,
  setReminderHour,
  optOutCues,
} from '../services/h13/h13Service';

/**
 * H13 · Reto de la Primera Semana — endpoints del flujo (Fase 3).
 * El app consulta GET /state al abrir el dashboard y hace POST a los demás cuando
 * el usuario toca un botón del slot. Todo requiere sesión (authenticateToken).
 */

export const getState = async (req: Request, res: Response) => {
  const userId = (req as { user?: { id?: string } }).user?.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    return res.json(await getH13State(userId));
  } catch (err) {
    logger.error('[H13Controller] getState:', err);
    // Nunca romper el dashboard por H13: devolver "nada que mostrar".
    return res.json({ view: 'none' });
  }
};

export const postOffer = async (req: Request, res: Response) => {
  const userId = (req as { user?: { id?: string } }).user?.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const decision = req.body?.decision;
  if (decision !== 'accept' && decision !== 'decline') {
    return res.status(400).json({ error: 'decision debe ser accept | decline' });
  }
  try {
    return res.json(await respondOffer(userId, decision));
  } catch (err) {
    logger.error('[H13Controller] postOffer:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const postHour = async (req: Request, res: Response) => {
  const userId = (req as { user?: { id?: string } }).user?.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const hour = Number(req.body?.hour);
  if (![12, 18, 21].includes(hour)) {
    return res.status(400).json({ error: 'hour debe ser 12 | 18 | 21' });
  }
  try {
    const result = await setReminderHour(userId, hour);
    return res.json(result);
  } catch (err) {
    logger.error('[H13Controller] postHour:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

export const postOptout = async (req: Request, res: Response) => {
  const userId = (req as { user?: { id?: string } }).user?.id;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    return res.json(await optOutCues(userId));
  } catch (err) {
    logger.error('[H13Controller] postOptout:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
