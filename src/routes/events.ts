import express, { Router } from 'express';
import { trackEvent } from '../controllers/events';
import { apiLimiter } from '../config/rateLimiter';

const router: Router = express.Router();

// POST /api/events/track — público (sin auth) para soportar visitantes anónimos
// Rate limited con apiLimiter para prevenir abuso.
router.post('/track', apiLimiter, trackEvent);

export default router;
