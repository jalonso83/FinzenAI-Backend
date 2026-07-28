import express, { Router } from 'express';
import {
  getRecurringTransactions,
  toggleRecurringTransaction,
  deleteRecurringTransaction,
} from '../controllers/recurringTransactions';
import { authenticateToken } from '../middlewares/auth';

const router: Router = express.Router();

// Todas las rutas requieren autenticación
router.use(authenticateToken);

// Las reglas se CREAN desde POST /api/transactions (campo `recurrence`), no
// aquí: la recurrencia nace pegada a una transacción real para que el usuario
// no tenga que llenar un formulario aparte.
router.get('/', getRecurringTransactions);
router.patch('/:id/toggle', toggleRecurringTransaction);
router.delete('/:id', deleteRecurringTransaction);

export default router;
