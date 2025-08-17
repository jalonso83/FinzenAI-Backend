import { Router } from 'express';
import type { Router as ExpressRouter } from 'express';
import { GamificationController } from '../controllers/gamification';
import { authenticateToken } from '../middlewares/auth';

const router: ExpressRouter = Router();

// Todas las rutas requieren autenticación
router.use(authenticateToken);

// Rutas de FinScore
router.get('/finscore', GamificationController.getFinScore);
router.get('/finscore/history', GamificationController.getFinScoreHistory);
router.post('/finscore/recalculate', GamificationController.recalculateFinScore);

// Rutas de Badges
router.get('/badges', GamificationController.getUserBadges);

// Rutas de Rachas
router.get('/streak', GamificationController.getUserStreak);

// Rutas de Estadísticas
router.get('/stats', GamificationController.getGamificationStats);

// Rutas de Eventos
router.get('/events/recent', GamificationController.getRecentEvents);

// Rutas de Rankings
router.get('/leaderboard', GamificationController.getLeaderboard);

// Rutas para Testing/Admin
router.post('/events/dispatch', GamificationController.dispatchEvent);

export default router;