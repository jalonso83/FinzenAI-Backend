import { Router } from 'express';
import type { Router as ExpressRouter } from 'express';
import { authenticateToken } from '../middlewares/auth';
import { apiLimiter } from '../config/rateLimiter';
import { getState, postOffer, postHour, postOptout } from '../controllers/h13';

/**
 * H13 · Reto de la Primera Semana — /api/h13
 * Todo requiere sesión. El app usa /state al abrir el dashboard y los POST cuando
 * el usuario toca un botón del slot.
 */
// Anotación de tipo explícita: sin ella, con pnpm (node_modules .pnpm) tsc no puede
// nombrar el tipo inferido del Router y falla con TS2742 en el build de Railway.
const router: ExpressRouter = Router();

router.get('/state', apiLimiter, authenticateToken, getState);
router.post('/offer', apiLimiter, authenticateToken, postOffer);
router.post('/hour', apiLimiter, authenticateToken, postHour);
router.post('/optout', apiLimiter, authenticateToken, postOptout);

export default router;
