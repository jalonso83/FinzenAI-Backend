import { Router } from 'express';
import { authenticateAdmin } from '../middlewares/adminAuth';
import { strictApiLimiter } from '../config/rateLimiter';
import { getPulse, getUsersAnalytics, getRevenueAnalytics, getEngagement } from '../controllers/admin';

const router = Router();

// All admin routes require admin authentication + strict rate limiting (30/min)
router.use(authenticateAdmin);
router.use(strictApiLimiter);

router.get('/pulse', getPulse);
router.get('/users', getUsersAnalytics);
router.get('/revenue', getRevenueAnalytics);
router.get('/engagement', getEngagement);

export default router;
