import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { GmailService } from '../services/gmailService';
import { OutlookService } from '../services/outlookService';
import { EmailSyncService } from '../services/emailSyncService';
import { sanitizeLimit, sanitizePage, PAGINATION } from '../config/pagination';
import { recordFeatureUsage } from '../lib/featureUsage';

import { logger } from '../utils/logger';

// ─────────────────────────────────────────────────────────────────────────────
// Embudo de "Gastos en automático" (2026-08-23)
//
// Hasta ahora no había forma de distinguir "nunca lo intentó" de "lo intentó y
// falló": los dos casos se veían igual, como la nada. La fila de EmailConnection
// solo se crea cuando el OAuth termina bien, así que abandonar a mitad no dejaba
// rastro alguno.
//
// Tres eventos, y la diferencia entre cada par es un diagnóstico distinto:
//   abrio_pantalla → inicio_conexion   la caída aquí es el COPY: llegó y no convenció
//   inicio_conexion → conecto          la caída aquí es el PERMISO de Google
//   pocos abrio_pantalla               entonces el problema es DESCUBRIMIENTO
// ─────────────────────────────────────────────────────────────────────────────
const FEATURE_EMAIL_SYNC = 'email_sync';

const ALLOWED_REDIRECT_PREFIXES = [
  'finzenai://',
  'https://finzenai-backend-production.up.railway.app',
];

function isValidRedirectUrl(url: string): boolean {
  return ALLOWED_REDIRECT_PREFIXES.some(prefix => url.startsWith(prefix));
}

/**
 * Obtiene la URL de autorizacion para Gmail
 * GET /api/email-sync/gmail/auth-url
 */
export const getGmailAuthUrl = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    const { mobileRedirectUrl } = req.query;

    if (!userId) {
      return res.status(401).json({ error: 'No autorizado' });
    }

    // Embudo de Gastos en automático — paso 2 de 3 (ver la nota de
    // getConnectionStatus). Se registra ANTES de devolver la URL: lo que se
    // mide es la INTENCIÓN de conectar, y a partir de aquí el usuario sale de
    // nuestra app hacia la pantalla de consentimiento de Google. Si nunca
    // vuelve, la diferencia entre este evento y `conecto` es exactamente la
    // gente que se asustó con el permiso.
    recordFeatureUsage(userId, FEATURE_EMAIL_SYNC, 'inicio_conexion', { proveedor: 'gmail' });

    // Verificar si ya hay una conexión de Gmail activa
    const existingGmail = await prisma.emailConnection.findFirst({
      where: { userId, provider: 'GMAIL', isActive: true }
    });

    if (existingGmail) {
      return res.status(409).json({
        error: 'Gmail ya conectado',
        message: 'Ya tienes una cuenta de Gmail conectada. Desconéctala primero si deseas usar otra.',
        email: existingGmail.email
      });
    }

    const authUrl = GmailService.getAuthorizationUrl(
      userId,
      mobileRedirectUrl as string | undefined
    );

    return res.json({
      success: true,
      authUrl
    });

  } catch (error: any) {
    logger.error('[EmailSync] Error getting auth URL:', error);
    return res.status(500).json({
      error: 'Error al obtener URL de autorizacion',
      message: error.message
    });
  }
};

/**
 * Callback de autorizacion OAuth de Gmail
 * GET /api/email-sync/gmail/callback
 */
export const handleGmailCallback = async (req: Request, res: Response) => {
  // Decodificar el state para obtener userId y mobileRedirectUrl
  let userId: string | undefined;
  let mobileRedirectUrl = 'finzenai://email-sync/callback';

  try {
    const { code, state, error } = req.query;

    // Intentar decodificar el state
    if (state) {
      try {
        const stateData = JSON.parse(Buffer.from(state as string, 'base64').toString('utf-8'));
        userId = stateData.userId;
        mobileRedirectUrl = stateData.mobileRedirectUrl || mobileRedirectUrl;
      } catch (e) {
        logger.error('[EmailSync] Invalid OAuth state:', e);
        return res.status(400).json({ error: 'Estado OAuth inválido' });
      }
    }

    // Validar redirect URL contra allowlist
    if (!isValidRedirectUrl(mobileRedirectUrl)) {
      logger.error('[EmailSync] Invalid redirect URL blocked:', mobileRedirectUrl);
      return res.status(400).json({ error: 'Invalid redirect URL' });
    }

    if (error) {
      logger.error('[EmailSync] OAuth error:', error);
      return res.redirect(`${mobileRedirectUrl}?error=${error}`);
    }

    if (!code || !userId) {
      return res.redirect(`${mobileRedirectUrl}?error=missing_params`);
    }

    // Conectar Gmail
    const connection = await EmailSyncService.connectGmail(
      userId,
      code as string
    );

    logger.log(`[EmailSync] Gmail connected for user ${userId}: ${connection.email}`);

    // Redirigir a la app con exito
    return res.redirect(`${mobileRedirectUrl}?success=true&email=${encodeURIComponent(connection.email)}`);

  } catch (error: any) {
    logger.error('[EmailSync] Callback error:', error);
    return res.redirect(`${mobileRedirectUrl}?error=${encodeURIComponent(error.message)}`);
  }
};

/**
 * Obtiene la URL de autorizacion para Outlook
 * GET /api/email-sync/outlook/auth-url
 */
export const getOutlookAuthUrl = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    const { mobileRedirectUrl } = req.query;

    if (!userId) {
      return res.status(401).json({ error: 'No autorizado' });
    }

    recordFeatureUsage(userId, FEATURE_EMAIL_SYNC, 'inicio_conexion', { proveedor: 'outlook' });

    // Verificar si ya hay una conexión de Outlook activa
    const existingOutlook = await prisma.emailConnection.findFirst({
      where: { userId, provider: 'OUTLOOK', isActive: true }
    });

    if (existingOutlook) {
      return res.status(409).json({
        error: 'Outlook ya conectado',
        message: 'Ya tienes una cuenta de Outlook conectada. Desconéctala primero si deseas usar otra.',
        email: existingOutlook.email
      });
    }

    const authUrl = OutlookService.getAuthorizationUrl(
      userId,
      mobileRedirectUrl as string | undefined
    );

    return res.json({
      success: true,
      authUrl
    });

  } catch (error: any) {
    logger.error('[EmailSync] Error getting Outlook auth URL:', error);
    return res.status(500).json({
      error: 'Error al obtener URL de autorizacion',
      message: error.message
    });
  }
};

/**
 * Callback de autorizacion OAuth de Outlook
 * GET /api/email-sync/outlook/callback
 */
export const handleOutlookCallback = async (req: Request, res: Response) => {
  // Decodificar el state para obtener userId y mobileRedirectUrl
  let userId: string | undefined;
  let mobileRedirectUrl = 'finzenai://email-sync/callback';

  try {
    const { code, state, error, error_description, error_uri } = req.query;

    // Log all query params for debugging
    logger.log('[EmailSync] Outlook callback received:', {
      hasCode: !!code,
      hasState: !!state,
      error,
      error_description,
      error_uri
    });

    // Intentar decodificar el state
    if (state) {
      try {
        const stateData = JSON.parse(Buffer.from(state as string, 'base64').toString('utf-8'));
        userId = stateData.userId;
        mobileRedirectUrl = stateData.mobileRedirectUrl || mobileRedirectUrl;
      } catch (e) {
        logger.error('[EmailSync] Invalid Outlook OAuth state:', e);
        return res.status(400).json({ error: 'Estado OAuth inválido' });
      }
    }

    // Validar redirect URL contra allowlist
    if (!isValidRedirectUrl(mobileRedirectUrl)) {
      logger.error('[EmailSync] Invalid redirect URL blocked:', mobileRedirectUrl);
      return res.status(400).json({ error: 'Invalid redirect URL' });
    }

    if (error) {
      logger.error('[EmailSync] Outlook OAuth error:', {
        error,
        description: error_description,
        uri: error_uri
      });
      const errorMsg = error_description || error || 'Unknown error';
      return res.redirect(`${mobileRedirectUrl}?error=${error}&message=${encodeURIComponent(errorMsg as string)}`);
    }

    if (!code || !userId) {
      return res.redirect(`${mobileRedirectUrl}?error=missing_params`);
    }

    // Conectar Outlook
    const connection = await EmailSyncService.connectOutlook(
      userId,
      code as string
    );

    // Redirigir a la app con exito
    return res.redirect(`${mobileRedirectUrl}?success=true&email=${encodeURIComponent(connection.email)}&provider=outlook`);

  } catch (error: any) {
    logger.error('[EmailSync] Outlook callback error:', error);
    return res.redirect(`${mobileRedirectUrl}?error=${encodeURIComponent(error.message)}`);
  }
};

/**
 * Obtiene el estado de conexion de email
 * GET /api/email-sync/status
 */
export const getConnectionStatus = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'No autorizado' });
    }

    // Embudo de Gastos en automático — paso 1 de 3. La pantalla llama a este
    // endpoint al montarse y no lo llama nadie más, así que equivale a "abrió
    // la pantalla" (mismo truco con el que se mide `ver_planes`).
    //
    // OJO al leerlo: la ruta está detrás de requirePlan('PRO'), así que este
    // embudo mide SOLO a usuarios Pro. Al usuario gratis que toca la opción del
    // menú se le abre el modal de Suscripciones y su toque se pierde entre los
    // `ver_planes` — para separarlo hace falta que la app mande el origen, y
    // eso es cambio de app.
    recordFeatureUsage(userId, FEATURE_EMAIL_SYNC, 'abrio_pantalla');

    const status = await EmailSyncService.getConnectionStatus(userId);
    // El progreso viaja junto al estado para que la pantalla de conexión no
    // tenga que pedir dos cosas: con una sola llamada sabe si está conectado y
    // por dónde va la sincronización.
    const progreso = await EmailSyncService.getSyncProgress(userId);

    return res.json({
      success: true,
      ...status,
      progreso,
    });
  } catch (error: any) {
    logger.error('[EmailSync] Error getting status:', error);
    return res.status(500).json({ error: 'Error obteniendo estado', message: error.message });
  }
};

/**
 * GET /api/email-sync/progress — solo el avance, para consultar cada pocos
 * segundos mientras corre la primera sincronización. Separado de /status para
 * que sondear sea barato: una fila, sin joins.
 */
export const getSyncProgress = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'No autorizado' });
    }

    const progreso = await EmailSyncService.getSyncProgress(userId);
    return res.json({ success: true, ...progreso });
  } catch (error: any) {
    logger.error('[EmailSync] Error getting progress:', error);
    return res.status(500).json({ error: 'Error obteniendo progreso', message: error.message });
  }
};

/**
 * Inicia sincronizacion manual de todas las conexiones
 * POST /api/email-sync/sync
 */
export const triggerSync = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'No autorizado' });
    }

    // Sincronizar todas las conexiones activas
    const { results, totalTransactions } = await EmailSyncService.syncAllUserConnections(userId);

    // Calcular totales
    const totalEmailsProcessed = results.reduce((sum, r) => sum + r.emailsProcessed, 0);
    const totalEmailsSkipped = results.reduce((sum, r) => sum + r.emailsSkipped, 0);

    return res.json({
      success: true,
      message: `Sincronización completada: ${totalTransactions} transacciones importadas`,
      result: {
        connectionsProcessed: results.length,
        transactionsCreated: totalTransactions,
        emailsProcessed: totalEmailsProcessed,
        emailsSkipped: totalEmailsSkipped,
        details: results
      }
    });

  } catch (error: any) {
    logger.error('[EmailSync] Sync error:', error);
    return res.status(500).json({
      error: 'Error en sincronizacion',
      message: error.message
    });
  }
};

/**
 * Desconecta una conexión de email específica
 * DELETE /api/email-sync/disconnect/:connectionId
 */
export const disconnectEmail = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    const { connectionId } = req.params;

    if (!userId) {
      return res.status(401).json({ error: 'No autorizado' });
    }

    if (connectionId) {
      // Desconectar conexión específica
      await EmailSyncService.disconnectEmailById(connectionId, userId);
    } else {
      // Compatibilidad: desconectar la primera conexión activa
      await EmailSyncService.disconnectEmail(userId);
    }

    return res.json({
      success: true,
      message: 'Email desconectado correctamente'
    });

  } catch (error: any) {
    logger.error('[EmailSync] Disconnect error:', error);
    return res.status(500).json({
      error: 'Error al desconectar',
      message: error.message
    });
  }
};

/**
 * Obtiene historial de emails importados
 * GET /api/email-sync/history
 */
export const getImportHistory = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    const { page, limit, status } = req.query;

    // Sanitizar paginación con límite máximo de 50
    const pageNum = sanitizePage(page as string);
    const limitNum = sanitizeLimit(limit as string, PAGINATION.MAX_LIMITS.EMAIL_SYNC, 20);

    if (!userId) {
      return res.status(401).json({ error: 'No autorizado' });
    }

    const connection = await prisma.emailConnection.findFirst({
      where: { userId, isActive: true }
    });

    if (!connection) {
      return res.json({
        success: true,
        emails: [],
        total: 0
      });
    }

    const where: any = { emailConnectionId: connection.id };
    if (status) {
      where.status = status;
    }

    const [emails, total] = await Promise.all([
      prisma.importedBankEmail.findMany({
        where,
        orderBy: { receivedAt: 'desc' },
        skip: (pageNum - 1) * limitNum,
        take: limitNum,
        select: {
          id: true,
          subject: true,
          senderEmail: true,
          receivedAt: true,
          status: true,
          parsedData: true,
          transactionId: true,
          processedAt: true,
          errorMessage: true
        }
      }),
      prisma.importedBankEmail.count({ where })
    ]);

    return res.json({
      success: true,
      emails,
      total,
      page: Number(page),
      totalPages: Math.ceil(total / Number(limit))
    });

  } catch (error: any) {
    logger.error('[EmailSync] History error:', error);
    return res.status(500).json({
      error: 'Error al obtener historial',
      message: error.message
    });
  }
};

/**
 * Obtiene logs de sincronizacion
 * GET /api/email-sync/logs
 */
export const getSyncLogs = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    const { limit } = req.query;

    // Sanitizar límite máximo de 50
    const limitNum = sanitizeLimit(limit as string, PAGINATION.MAX_LIMITS.EMAIL_SYNC, 10);

    if (!userId) {
      return res.status(401).json({ error: 'No autorizado' });
    }

    const connection = await prisma.emailConnection.findFirst({
      where: { userId, isActive: true }
    });

    if (!connection) {
      return res.json({
        success: true,
        logs: []
      });
    }

    const logs = await prisma.emailSyncLog.findMany({
      where: { emailConnectionId: connection.id },
      orderBy: { startedAt: 'desc' },
      take: limitNum
    });

    return res.json({
      success: true,
      logs
    });

  } catch (error: any) {
    logger.error('[EmailSync] Logs error:', error);
    return res.status(500).json({
      error: 'Error al obtener logs',
      message: error.message
    });
  }
};

/**
 * Obtiene bancos configurados
 * GET /api/email-sync/banks
 */
export const getConfiguredBanks = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'No autorizado' });
    }

    const connection = await prisma.emailConnection.findFirst({
      where: { userId, isActive: true },
      include: {
        bankFilters: true
      }
    });

    if (!connection) {
      return res.json({
        success: true,
        banks: []
      });
    }

    return res.json({
      success: true,
      banks: connection.bankFilters.map(f => ({
        id: f.id,
        name: f.bankName,
        emails: f.senderEmails,
        keywords: f.subjectKeywords,
        isActive: f.isActive
      }))
    });

  } catch (error: any) {
    logger.error('[EmailSync] Banks error:', error);
    return res.status(500).json({
      error: 'Error al obtener bancos',
      message: error.message
    });
  }
};

/**
 * Activa/desactiva un filtro de banco
 * PATCH /api/email-sync/banks/:bankId/toggle
 */
export const toggleBankFilter = async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    const { bankId } = req.params;
    const { isActive } = req.body;

    if (!userId) {
      return res.status(401).json({ error: 'No autorizado' });
    }

    // Verificar que el filtro pertenece al usuario
    const filter = await prisma.bankEmailFilter.findFirst({
      where: { id: bankId },
      include: {
        emailConnection: true
      }
    });

    if (!filter || filter.emailConnection.userId !== userId) {
      return res.status(404).json({ error: 'Filtro no encontrado' });
    }

    const updated = await prisma.bankEmailFilter.update({
      where: { id: bankId },
      data: { isActive: isActive !== false }
    });

    return res.json({
      success: true,
      bank: {
        id: updated.id,
        name: updated.bankName,
        isActive: updated.isActive
      }
    });

  } catch (error: any) {
    logger.error('[EmailSync] Toggle bank error:', error);
    return res.status(500).json({
      error: 'Error al actualizar filtro',
      message: error.message
    });
  }
};

/**
 * Obtiene bancos soportados globalmente
 * GET /api/email-sync/supported-banks
 */
export const getSupportedBanks = async (req: Request, res: Response) => {
  try {
    const { country } = req.query;

    // Obtener bancos de la base de datos
    const banks = await prisma.supportedBank.findMany({
      where: {
        isActive: true,
        ...(country && { country: country as string })
      },
      select: {
        id: true,
        name: true,
        country: true,
        logoUrl: true,
        senderEmails: true
      },
      orderBy: { name: 'asc' }
    });

    return res.json({
      success: true,
      banks,
      total: banks.length
    });

  } catch (error: any) {
    logger.error('[EmailSync] Supported banks error:', error);
    return res.status(500).json({
      error: 'Error al obtener bancos soportados',
      message: error.message
    });
  }
};

export default {
  getGmailAuthUrl,
  handleGmailCallback,
  getOutlookAuthUrl,
  handleOutlookCallback,
  getConnectionStatus,
  triggerSync,
  disconnectEmail,
  getImportHistory,
  getSyncLogs,
  getConfiguredBanks,
  toggleBankFilter,
  getSupportedBanks
};
