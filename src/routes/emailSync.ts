import { Router } from 'express';
import { authenticateToken } from '../middlewares/auth';
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

const router: ReturnType<typeof Router> = Router();

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
router.get('/gmail/auth-url', authenticateToken, getGmailAuthUrl);

// Obtener estado de conexion
router.get('/status', authenticateToken, getConnectionStatus);

// Iniciar sincronizacion manual
router.post('/sync', authenticateToken, triggerSync);

// Desconectar email
router.delete('/disconnect', authenticateToken, disconnectEmail);

// Historial de emails importados
router.get('/history', authenticateToken, getImportHistory);

// Logs de sincronizacion
router.get('/logs', authenticateToken, getSyncLogs);

// Bancos configurados del usuario
router.get('/banks', authenticateToken, getConfiguredBanks);

// Activar/desactivar filtro de banco
router.patch('/banks/:bankId/toggle', authenticateToken, toggleBankFilter);

export default router;
