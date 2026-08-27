import express, { Router } from 'express';
import { 
  getTransactions, 
  createTransaction, 
  updateTransaction, 
  deleteTransaction,
  getTransactionById,
  aplicarCategoriaAComercio
} from '../controllers/transactions';
import { authenticateToken } from '../middlewares/auth';

const router: Router = express.Router();

// Todas las rutas requieren autenticación
router.use(authenticateToken);

// Rutas de transacciones
router.get('/', getTransactions);
router.get('/:id', getTransactionById);
router.post('/', createTransaction);
router.put('/:id', updateTransaction);

// Recategorizar de golpe todas las transacciones de un comercio.
// No choca con `/:id` porque no existe ningún POST con parámetro.
router.post('/aplicar-categoria-comercio', aplicarCategoriaAComercio);
router.delete('/:id', deleteTransaction);

export default router; 