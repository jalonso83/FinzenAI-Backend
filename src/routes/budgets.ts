import express from 'express';
import { 
  getBudgets, 
  createBudget, 
  updateBudget, 
  deleteBudget,
  getBudgetById 
} from '../controllers/budgets';
import { authenticateToken } from '../middlewares/auth';

const router = express.Router();

// Todas las rutas requieren autenticación
router.use(authenticateToken);

// Rutas de presupuestos
router.get('/', getBudgets);
router.get('/:id', getBudgetById);
router.post('/', createBudget);
router.put('/:id', updateBudget);
router.delete('/:id', deleteBudget);

export default router; 