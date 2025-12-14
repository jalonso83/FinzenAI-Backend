import { Router } from 'express';
import { authMiddleware } from '../middlewares/auth';
import {
  getGmailAuthUrl,
  handleGmailCallback,
  getConnectionStatus,
  triggerSync,
  disconnectEmail,
  getImportHistory,
  getSyncLogs,
  getConfiguredBanks,
  toggleBankFilter,
  getSupportedBanks
} from '../controllers/emailSync';

const router = Router();

// =============================================
// RUTAS PUBLICAS (Sin autenticacion)
// =============================================

// Callback de OAuth de Gmail (debe ser publico para que Google pueda redirigir)
router.get('/gmail/callback', handleGmailCallback);

// Bancos soportados (puede ser publico)
router.get('/supported-banks', getSupportedBanks);

// =============================================
// RUTAS PROTEGIDAS (Requieren autenticacion)
// =============================================

// Obtener URL de autorizacion de Gmail
router.get('/gmail/auth-url', authMiddleware, getGmailAuthUrl);

// Obtener estado de conexion
router.get('/status', authMiddleware, getConnectionStatus);

// Iniciar sincronizacion manual
router.post('/sync', authMiddleware, triggerSync);

// Desconectar email
router.delete('/disconnect', authMiddleware, disconnectEmail);

// Historial de emails importados
router.get('/history', authMiddleware, getImportHistory);

// Logs de sincronizacion
router.get('/logs', authMiddleware, getSyncLogs);

// Bancos configurados del usuario
router.get('/banks', authMiddleware, getConfiguredBanks);

// Activar/desactivar filtro de banco
router.patch('/banks/:bankId/toggle', authMiddleware, toggleBankFilter);

export default router;
