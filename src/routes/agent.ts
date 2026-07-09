import { Router } from 'express';
import type { Router as ExpressRouter } from 'express';
import { agentApiKeyAuth } from '../middlewares/agentApiKeyAuth';
import { strictApiLimiter } from '../config/rateLimiter';
import { getAgentKpis, listAgentSegments, evaluateAgentSegment, createAgentCampaignDraft } from '../controllers/agent';

// Agent API — consumida por el agente de crecimiento (proyecto externo).
// Auth por API key (x-agent-key), NO por JWT de usuario.
const router: ExpressRouter = Router();

router.use(strictApiLimiter);
router.use(agentApiKeyAuth);

router.get('/kpis', getAgentKpis);
router.get('/segments', listAgentSegments);
router.get('/segments/:slug', evaluateAgentSegment);
router.post('/campaigns', createAgentCampaignDraft);

export default router;
