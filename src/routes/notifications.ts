import express, { Router, Request, Response } from 'express';
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
import { BudgetReminderService } from '../services/budgetReminderService';

const router: Router = express.Router();

// Ruta para ejecutar job de recordatorios (protegida por API key)
router.post('/run-daily-reminders', async (req: Request, res: Response) => {
  const apiKey = req.headers['x-api-key'];
  const expectedKey = process.env.CRON_API_KEY || 'default-cron-key';

  if (apiKey !== expectedKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const results = await BudgetReminderService.runDailyReminders();
    return res.status(200).json({
      success: true,
      ...results
    });
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Todas las rutas siguientes requieren autenticación
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
