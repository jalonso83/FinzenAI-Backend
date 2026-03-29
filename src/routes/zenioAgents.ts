/**
 * Rutas del sistema de agentes de Zenio
 * Endpoint independiente: /api/zenio/agents/chat
 * No modifica las rutas existentes de /zenio/v2/
 */

import { Router, type Router as RouterType } from 'express';
import { chatWithZenioAgents } from '../controllers/zenioAgents';
import { authenticateToken } from '../middlewares/auth';
import { strictApiLimiter } from '../config/rateLimiter';

const router: RouterType = Router();

// Chat con agentes especializados (Router → Asistente | Educativo)
router.post('/chat', strictApiLimiter, authenticateToken, chatWithZenioAgents);

export default router;
