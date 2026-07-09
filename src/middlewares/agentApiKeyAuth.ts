import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

// ─────────────────────────────────────────────────────────────────────────
// Auth de la Agent API (agente de crecimiento externo).
// Valida el header `x-agent-key` contra AGENT_API_KEY (env var en Railway).
//  - Sin AGENT_API_KEY configurada → 503 (la API está apagada; esto ES el
//    kill switch del lado FinZen: borrar la env var revoca el acceso).
//  - Comparación en tiempo constante (timingSafeEqual) para no filtrar la
//    key por timing.
// La key es de permisos mínimos: las rutas montadas bajo /api/agent solo
// exponen lecturas agregadas (KPIs, segmentos sin PII) y creación de
// borradores PENDING_APPROVAL — nunca envíos.
// ─────────────────────────────────────────────────────────────────────────

export const agentApiKeyAuth = (req: Request, res: Response, next: NextFunction) => {
  const expectedKey = process.env.AGENT_API_KEY;
  if (!expectedKey) {
    return res.status(503).json({ message: 'Agent API deshabilitada', error: 'Service unavailable' });
  }

  const providedKey = req.headers['x-agent-key'];
  if (typeof providedKey !== 'string' || providedKey.length === 0) {
    return res.status(401).json({ message: 'Falta el header x-agent-key', error: 'Unauthorized' });
  }

  const provided = Buffer.from(providedKey);
  const expected = Buffer.from(expectedKey);
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    return res.status(401).json({ message: 'API key inválida', error: 'Unauthorized' });
  }

  return next();
};
