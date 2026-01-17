import express, { Router } from 'express';
import {
  registerDevice,
  unregisterDevice,
  getPreferences,
  updatePreferences,
  getNotificationHistory,
  markAsRead,
  deleteNotification,
  deleteAllNotifications,
  sendTestNotification,
  sendTestTip
} from '../controllers/notifications';
import { authenticateToken } from '../middlewares/auth';

const router: Router = express.Router();

// Todas las rutas requieren autenticación
router.use(authenticateToken);

// Registro de dispositivos
router.post('/device', registerDevice);
router.delete('/device', unregisterDevice);

// Preferencias de notificación
router.get('/preferences', getPreferences);
router.put('/preferences', updatePreferences);

// Historial de notificaciones
router.get('/history', getNotificationHistory);
router.put('/:id/read', markAsRead);

// Eliminar notificaciones
router.delete('/all', deleteAllNotifications);
router.delete('/:id', deleteNotification);

// Prueba (solo desarrollo)
router.post('/test', sendTestNotification);
router.post('/test-tip', sendTestTip);

export default router;
