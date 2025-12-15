import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { GmailService } from '../services/gmailService';
import { EmailSyncService } from '../services/emailSyncService';

const prisma = new PrismaClient();

/**
 * Obtiene la URL de autorizacion para Gmail
 * GET /api/email-sync/gmail/auth-url
 */
export const getGmailAuthUrl = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;
    const { mobileRedirectUrl } = req.query;

    if (!userId) {
      return res.status(401).json({ error: 'No autorizado' });
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
    console.error('[EmailSync] Error getting auth URL:', error);
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
        // Si falla el decode, asumir que state es el userId (compatibilidad)
        userId = state as string;
      }
    }

    if (error) {
      console.error('[EmailSync] OAuth error:', error);
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

    console.log(`[EmailSync] Gmail connected for user ${userId}: ${connection.email}`);

    // Redirigir a la app con exito
    return res.redirect(`${mobileRedirectUrl}?success=true&email=${encodeURIComponent(connection.email)}`);

  } catch (error: any) {
    console.error('[EmailSync] Callback error:', error);
    return res.redirect(`${mobileRedirectUrl}?error=${encodeURIComponent(error.message)}`);
  }
};

/**
 * Obtiene el estado de conexion de email
 * GET /api/email-sync/status
 */
export const getConnectionStatus = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;

    if (!userId) {
      return res.status(401).json({ error: 'No autorizado' });
    }

    const status = await EmailSyncService.getConnectionStatus(userId);

    return res.json({
      success: true,
      ...status
    });

  } catch (error: any) {
    console.error('[EmailSync] Error getting status:', error);
    return res.status(500).json({
      error: 'Error al obtener estado',
      message: error.message
    });
  }
};

/**
 * Inicia sincronizacion manual
 * POST /api/email-sync/sync
 */
export const triggerSync = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;

    if (!userId) {
      return res.status(401).json({ error: 'No autorizado' });
    }

    // Obtener conexion activa
    const connection = await prisma.emailConnection.findFirst({
      where: { userId, isActive: true }
    });

    if (!connection) {
      return res.status(404).json({
        error: 'No hay email conectado',
        message: 'Primero debes conectar tu cuenta de Gmail'
      });
    }

    // Verificar que no haya sync en progreso
    if (connection.lastSyncStatus === 'IN_PROGRESS') {
      return res.status(409).json({
        error: 'Sincronizacion en progreso',
        message: 'Ya hay una sincronizacion en curso, espera a que termine'
      });
    }

    // Iniciar sincronizacion
    const result = await EmailSyncService.syncUserEmails(connection.id);

    return res.json({
      success: true,
      message: `Sincronizacion completada: ${result.transactionsCreated} transacciones importadas`,
      result
    });

  } catch (error: any) {
    console.error('[EmailSync] Sync error:', error);
    return res.status(500).json({
      error: 'Error en sincronizacion',
      message: error.message
    });
  }
};

/**
 * Desconecta el email
 * DELETE /api/email-sync/disconnect
 */
export const disconnectEmail = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).userId;

    if (!userId) {
      return res.status(401).json({ error: 'No autorizado' });
    }

    await EmailSyncService.disconnectEmail(userId);

    return res.json({
      success: true,
      message: 'Email desconectado correctamente'
    });

  } catch (error: any) {
    console.error('[EmailSync] Disconnect error:', error);
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
    const userId = (req as any).userId;
    const { page = 1, limit = 20, status } = req.query;

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
        skip: (Number(page) - 1) * Number(limit),
        take: Number(limit),
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
    console.error('[EmailSync] History error:', error);
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
    const userId = (req as any).userId;
    const { limit = 10 } = req.query;

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
      take: Number(limit)
    });

    return res.json({
      success: true,
      logs
    });

  } catch (error: any) {
    console.error('[EmailSync] Logs error:', error);
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
    const userId = (req as any).userId;

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
    console.error('[EmailSync] Banks error:', error);
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
    const userId = (req as any).userId;
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
    console.error('[EmailSync] Toggle bank error:', error);
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
    const { country = 'DO' } = req.query;

    const banks = await prisma.supportedBank.findMany({
      where: {
        country: country as string,
        isActive: true
      },
      select: {
        id: true,
        name: true,
        country: true,
        logoUrl: true
      }
    });

    // Si no hay bancos en DB, devolver los defaults
    if (banks.length === 0) {
      return res.json({
        success: true,
        banks: [
          { name: 'Banco Popular', country: 'DO' },
          { name: 'Banreservas', country: 'DO' },
          { name: 'BHD Leon', country: 'DO' },
          { name: 'Scotiabank', country: 'DO' },
          { name: 'Asociacion Popular', country: 'DO' },
          { name: 'Banco Santa Cruz', country: 'DO' }
        ]
      });
    }

    return res.json({
      success: true,
      banks
    });

  } catch (error: any) {
    console.error('[EmailSync] Supported banks error:', error);
    return res.status(500).json({
      error: 'Error al obtener bancos soportados',
      message: error.message
    });
  }
};

export default {
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
};
