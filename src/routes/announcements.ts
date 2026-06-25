import express, { Router } from 'express';
import { getAnnouncements, trackAnnouncementEvent } from '../controllers/announcements';
import { authenticateToken } from '../middlewares/auth';
import { apiLimiter } from '../config/rateLimiter';

const router: Router = express.Router();

// Mensajes activos del slot del dashboard para el usuario.
router.get('/', apiLimiter, authenticateToken, getAnnouncements);

// Evento del slot: impression | click | dismiss (para medir el funnel).
router.post('/:id/event', apiLimiter, authenticateToken, trackAnnouncementEvent);

export default router;
