import express, { Router } from 'express';
import { getCategories } from '../controllers/categories';
import { authenticateToken } from '../middlewares/auth';

const router: Router = express.Router();

// Todas las rutas requieren autenticación
router.use(authenticateToken);

// Obtener todas las categorías
router.get('/', getCategories);

export default router; 