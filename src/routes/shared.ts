import express, { Router } from 'express';
import { authenticateToken } from '../middlewares/auth';
import {
  invitarPresupuesto,
  verInvitacion,
  aceptarInvitacion,
  invitacionPendiente,
  descartarInvitacionPendiente,
  compartidosConmigo,
  detallePresupuesto,
  salir,
  quitarMiembro,
  dejarDeCompartir,
  porConfirmar,
  confirmarGasto,
  sacarDelCompartido,
  volverAContar,
  compartidoDeCategoria,
  invitarMeta,
  metasCompartidasConmigo,
  detalleMeta,
  quitarAportesDeExMiembro,
  convertirAportes,
  aportesConvertibles,
  resumenDeDueno,
} from '../controllers/shared';

// Presupuestos y metas compartidos (2026-10). Ver services/sharedService.ts
// y services/sharedGoalService.ts.
const router: Router = express.Router();

router.use(authenticateToken);

// Invitaciones
router.post('/budgets/:budgetId/invite', invitarPresupuesto);
router.get('/invitations/pending', invitacionPendiente);
router.delete('/invitations/pending', descartarInvitacionPendiente);
router.get('/invitations/:code', verInvitacion);
router.post('/invitations/:code/accept', aceptarInvitacion);

// Lo que ve cada uno
router.get('/budgets', compartidosConmigo);
router.get('/budgets/:budgetId', detallePresupuesto);
router.get('/categories/:categoryId', compartidoDeCategoria);
// Lo que yo comparto y con quién (pantalla de vencimiento del trial)
router.get('/mine', resumenDeDueno);

// Miembros
router.post('/groups/:groupId/leave', salir);
router.delete('/groups/:groupId/members/:userId', quitarMiembro);
router.delete('/groups/:groupId', dejarDeCompartir);

// Gastos automáticos por confirmar y "este es personal"
router.get('/pending-confirmations', porConfirmar);
router.post('/transactions/:transactionId/confirm', confirmarGasto);
router.post('/transactions/:transactionId/opt-out', sacarDelCompartido);
router.post('/transactions/:transactionId/opt-in', volverAContar);

// Metas compartidas (aportar sigue siendo POST /api/goals/:id/contribute)
router.post('/goals/:goalId/invite', invitarMeta);
router.get('/goals', metasCompartidasConmigo);
router.get('/goals/convertible', aportesConvertibles);
router.get('/goals/:goalId', detalleMeta);
router.post('/goals/:goalId/members/:userId/remove-contributions', quitarAportesDeExMiembro);
router.post('/groups/:groupId/convert-contributions', convertirAportes);

export default router;
