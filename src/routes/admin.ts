import { Router } from 'express';
import type { Router as ExpressRouter } from 'express';
import { authenticateAdmin } from '../middlewares/adminAuth';
import { strictApiLimiter } from '../config/rateLimiter';
import { getPulse, getUsersAnalytics, getRevenueAnalytics, getEngagement, getUnitEconomics, getFinancialHealth, getUsersList, getDistinctCountries, bulkResendVerification, getAcquisition } from '../controllers/admin';
import { getFeedbackList, updateFeedback } from '../controllers/feedback';

const router: ExpressRouter = Router();

// All admin routes require admin authentication + strict rate limiting (30/min)
router.use(authenticateAdmin);
router.use(strictApiLimiter);

router.get('/pulse', getPulse);
router.get('/users/list', getUsersList);
router.get('/users/countries', getDistinctCountries);
router.get('/users', getUsersAnalytics);
router.get('/revenue', getRevenueAnalytics);
router.get('/engagement', getEngagement);
router.get('/acquisition', getAcquisition);
router.get('/unit-economics', getUnitEconomics);
router.get('/financial-health', getFinancialHealth);
router.post('/users/resend-verification-bulk', bulkResendVerification);

// Feedback management
router.get('/feedback', getFeedbackList);
router.patch('/feedback/:id', updateFeedback);

export default router;
