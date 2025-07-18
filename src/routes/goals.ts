import express, { Router } from 'express';
import { 
  getUserGoals, 
  getGoalById, 
  createGoal, 
  updateGoal, 
  deleteGoal, 
  addContribution 
} from '../controllers/goals';
import { authenticateToken } from '../middlewares/auth';

const router: Router = express.Router();

// Aplicar middleware de autenticación a todas las rutas
router.use(authenticateToken);

// Obtener todas las metas del usuario
router.get('/', getUserGoals);

// Obtener una meta específica
router.get('/:id', getGoalById);

// Crear una nueva meta
router.post('/', createGoal);

// Actualizar una meta
router.put('/:id', updateGoal);

// Eliminar una meta
router.delete('/:id', deleteGoal);

// Agregar contribución a una meta
router.post('/:id/contribute', addContribution);

export default router; 