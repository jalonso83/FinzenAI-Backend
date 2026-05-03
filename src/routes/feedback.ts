import { Router } from 'express';
import type { Router as ExpressRouter } from 'express';
import { authenticateToken } from '../middlewares/auth';
import { feedbackLimiter } from '../config/rateLimiter';
import { submitFeedback } from '../controllers/feedback';

const router: ExpressRouter = Router();

router.post('/', authenticateToken, feedbackLimiter, submitFeedback);

export default router;
