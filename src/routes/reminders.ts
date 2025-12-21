import { Router } from 'express';
import { authenticateToken } from '../middlewares/auth';
import {
  getReminders,
  getReminderById,
  createReminder,
  updateReminder,
  deleteReminder,
  getUpcomingPayments,
  getReminderStats,
  getPaymentTypes,
  toggleReminder
} from '../controllers/reminders';

const router: ReturnType<typeof Router> = Router();

// =============================================
// RUTAS PÚBLICAS
// =============================================

// Obtener tipos de pago disponibles (público para mostrar en UI)
router.get('/types', getPaymentTypes);

// =============================================
// RUTAS PROTEGIDAS
// =============================================

// Aplicar autenticación a todas las rutas siguientes
router.use(authenticateToken);

// Obtener próximos pagos (debe ir antes de /:id para evitar conflicto)
router.get('/upcoming', getUpcomingPayments);

// Obtener estadísticas de recordatorios
router.get('/stats', getReminderStats);

// CRUD de recordatorios
router.get('/', getReminders);
router.get('/:id', getReminderById);
router.post('/', createReminder);
router.put('/:id', updateReminder);
router.delete('/:id', deleteReminder);

// Activar/desactivar recordatorio
router.patch('/:id/toggle', toggleReminder);

export default router;
