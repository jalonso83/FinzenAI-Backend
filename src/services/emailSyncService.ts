import { PrismaClient, EmailConnection, EmailSyncStatus, ImportedEmailStatus } from '@prisma/client';
import { GmailService } from './gmailService';
import { EmailParserService, ParsedTransaction } from './emailParserService';

const prisma = new PrismaClient();

// Bancos de RD por defecto - Emails verificados
const DEFAULT_BANK_FILTERS = [
  {
    bankName: 'Banco Popular',
    senderEmails: ['notificaciones@popularenlinea.com', 'alertas@bpd.com.do', 'notificaciones@bpd.com.do'],
    subjectKeywords: ['consumo', 'compra', 'transaccion', 'cargo', 'retiro', 'notificacion']
  },
  {
    bankName: 'Banreservas',
    senderEmails: ['notificaciones@banreservas.com', 'alertas@banreservas.com', 'notificaciones@banreservas.com.do'],
    subjectKeywords: ['consumo', 'compra', 'transaccion', 'cargo', 'notificacion']
  },
  {
    bankName: 'Banco Caribe',
    senderEmails: ['notificaciones@bancocaribe.com.do', 'alertas@bancocaribe.com.do'],
    subjectKeywords: ['consumo', 'compra', 'transaccion', 'cargo', 'notificacion']
  },
  {
    bankName: 'APAP',
    senderEmails: ['no-reply@apap.com.do', 'alertas@apap.com.do', 'notificaciones@apap.com.do'],
    subjectKeywords: ['consumo', 'compra', 'transaccion', 'cargo', 'notificacion']
  },
  {
    bankName: 'BHD Leon',
    senderEmails: ['alertas@bhdleon.com.do', 'notificaciones@bhdleon.com.do'],
    subjectKeywords: ['consumo', 'compra', 'transaccion', 'cargo', 'notificacion']
  },
  {
    bankName: 'Scotiabank',
    senderEmails: ['alertas@scotiabank.com', 'notificaciones.do@scotiabank.com'],
    subjectKeywords: ['consumo', 'compra', 'transaccion', 'cargo', 'notificacion']
  }
];

export interface SyncResult {
  success: boolean;
  emailsFound: number;
  emailsProcessed: number;
  emailsSkipped: number;
  transactionsCreated: number;
  errors: string[];
}

export class EmailSyncService {

  /**
   * Conecta la cuenta de Gmail de un usuario
   */
  static async connectGmail(userId: string, authCode: string): Promise<EmailConnection> {
    // Intercambiar codigo por tokens
    const tokens = await GmailService.exchangeCodeForTokens(authCode);

    // Obtener email del usuario de Google
    const gmailEmail = await GmailService.getUserEmail(tokens.access_token);

    // Crear o actualizar conexion
    const connection = await prisma.emailConnection.upsert({
      where: {
        userId_provider: {
          userId,
          provider: 'GMAIL'
        }
      },
      update: {
        email: gmailEmail,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || undefined,
        tokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000),
        isActive: true,
        lastSyncStatus: 'PENDING'
      },
      create: {
        userId,
        provider: 'GMAIL',
        email: gmailEmail,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || undefined,
        tokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000),
        isActive: true
      }
    });

    // Crear filtros de bancos por defecto
    await this.createDefaultBankFilters(connection.id);

    return connection;
  }

  /**
   * Crea filtros de bancos por defecto
   */
  private static async createDefaultBankFilters(connectionId: string): Promise<void> {
    for (const bank of DEFAULT_BANK_FILTERS) {
      await prisma.bankEmailFilter.upsert({
        where: {
          id: `${connectionId}-${bank.bankName.replace(/\s/g, '-').toLowerCase()}`
        },
        update: {
          senderEmails: bank.senderEmails,
          subjectKeywords: bank.subjectKeywords
        },
        create: {
          id: `${connectionId}-${bank.bankName.replace(/\s/g, '-').toLowerCase()}`,
          emailConnectionId: connectionId,
          bankName: bank.bankName,
          senderEmails: bank.senderEmails,
          subjectKeywords: bank.subjectKeywords
        }
      });
    }
  }

  /**
   * Sincroniza emails bancarios de un usuario
   */
  static async syncUserEmails(connectionId: string): Promise<SyncResult> {
    const result: SyncResult = {
      success: false,
      emailsFound: 0,
      emailsProcessed: 0,
      emailsSkipped: 0,
      transactionsCreated: 0,
      errors: []
    };

    // Crear log de sincronizacion
    const syncLog = await prisma.emailSyncLog.create({
      data: {
        emailConnectionId: connectionId,
        status: 'IN_PROGRESS'
      }
    });

    try {
      // Obtener conexion con filtros
      const connection = await prisma.emailConnection.findUnique({
        where: { id: connectionId },
        include: {
          bankFilters: { where: { isActive: true } },
          user: true
        }
      });

      if (!connection || !connection.isActive) {
        throw new Error('Email connection not found or inactive');
      }

      // Actualizar estado
      await prisma.emailConnection.update({
        where: { id: connectionId },
        data: { lastSyncStatus: 'IN_PROGRESS' }
      });

      // Asegurar token valido
      const accessToken = await GmailService.ensureValidToken(connection);

      // Recopilar todos los emails de los filtros
      const allSenderEmails: string[] = [];
      const allSubjectKeywords: string[] = [];

      console.log(`[EmailSync] Bank filters count: ${connection.bankFilters.length}`);

      for (const filter of connection.bankFilters) {
        console.log(`[EmailSync] Filter: ${filter.bankName} - Emails: ${filter.senderEmails.join(', ')}`);
        allSenderEmails.push(...filter.senderEmails);
        allSubjectKeywords.push(...filter.subjectKeywords);
      }

      console.log(`[EmailSync] Total sender emails: ${allSenderEmails.length}`);
      console.log(`[EmailSync] Sender emails: ${[...new Set(allSenderEmails)].join(', ')}`);
      console.log(`[EmailSync] Subject keywords: ${[...new Set(allSubjectKeywords)].join(', ')}`);

      // Buscar desde la ultima sincronizacion o ultimos 30 dias
      const afterDate = connection.lastSyncAt || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

      // Buscar emails
      const searchResult = await GmailService.searchBankEmails(
        accessToken,
        [...new Set(allSenderEmails)],
        [...new Set(allSubjectKeywords)],
        afterDate,
        100
      );

      result.emailsFound = searchResult.messages?.length || 0;

      console.log(`[EmailSync] Found ${result.emailsFound} bank emails for user ${connection.userId}`);

      if (!searchResult.messages || searchResult.messages.length === 0) {
        result.success = true;
        await this.finalizeSyncLog(syncLog.id, result, 'SUCCESS');
        await this.updateConnectionStatus(connectionId, 'SUCCESS');
        return result;
      }

      // Procesar cada email
      for (const message of searchResult.messages) {
        try {
          // Verificar si ya fue procesado
          const existing = await prisma.importedBankEmail.findFirst({
            where: {
              emailConnectionId: connectionId,
              gmailMessageId: message.id
            }
          });

          if (existing) {
            result.emailsSkipped++;
            continue;
          }

          // Obtener contenido del email
          const emailContent = await GmailService.getEmailContent(accessToken, message.id);
          const subject = GmailService.getHeader(emailContent, 'Subject') || '';
          const from = GmailService.getHeader(emailContent, 'From') || '';
          const body = GmailService.extractEmailBody(emailContent);
          const receivedAt = new Date(parseInt(emailContent.internalDate));

          // Determinar el banco
          const bankFilter = connection.bankFilters.find(f =>
            f.senderEmails.some(e => from.toLowerCase().includes(e.toLowerCase()))
          );

          // Guardar email importado
          const importedEmail = await prisma.importedBankEmail.create({
            data: {
              emailConnectionId: connectionId,
              gmailMessageId: message.id,
              subject,
              senderEmail: from,
              receivedAt,
              rawContent: body.substring(0, 5000), // Limitar tamano
              status: 'PROCESSING'
            }
          });

          // Parsear con AI
          const parseResult = await EmailParserService.parseEmailContent(
            body,
            subject,
            bankFilter?.bankName
          );

          if (!parseResult.success || !parseResult.transaction) {
            await prisma.importedBankEmail.update({
              where: { id: importedEmail.id },
              data: {
                status: 'FAILED',
                errorMessage: parseResult.error || 'Could not parse email',
                processedAt: new Date()
              }
            });
            result.errors.push(`Failed to parse email ${message.id}: ${parseResult.error}`);
            continue;
          }

          // Verificar duplicados
          const isDuplicate = await EmailParserService.checkForDuplicate(
            connection.userId,
            parseResult.transaction.amount,
            parseResult.transaction.date,
            parseResult.transaction.merchant
          );

          if (isDuplicate) {
            await prisma.importedBankEmail.update({
              where: { id: importedEmail.id },
              data: {
                status: 'DUPLICATE',
                parsedData: parseResult.transaction as any,
                processedAt: new Date()
              }
            });
            result.emailsSkipped++;
            continue;
          }

          // Crear transaccion
          const transaction = await this.createTransactionFromParsed(
            connection.userId,
            parseResult.transaction,
            importedEmail.id
          );

          if (transaction) {
            await prisma.importedBankEmail.update({
              where: { id: importedEmail.id },
              data: {
                status: 'SUCCESS',
                parsedData: parseResult.transaction as any,
                transactionId: transaction.id,
                processedAt: new Date()
              }
            });
            result.transactionsCreated++;
          }

          result.emailsProcessed++;

        } catch (error: any) {
          console.error(`[EmailSync] Error processing message ${message.id}:`, error);
          result.errors.push(`Error processing ${message.id}: ${error.message}`);
        }
      }

      result.success = true;
      await this.finalizeSyncLog(syncLog.id, result, 'SUCCESS');
      await this.updateConnectionStatus(connectionId, 'SUCCESS');

    } catch (error: any) {
      console.error('[EmailSync] Sync failed:', error);
      result.errors.push(error.message);
      await this.finalizeSyncLog(syncLog.id, result, 'FAILED', error.message);
      await this.updateConnectionStatus(connectionId, 'FAILED', error.message);
    }

    return result;
  }

  /**
   * Crea una transaccion a partir de datos parseados
   */
  private static async createTransactionFromParsed(
    userId: string,
    parsed: ParsedTransaction,
    importedEmailId: string
  ): Promise<any> {
    try {
      // Buscar categoria
      let categoryId = await EmailParserService.findCategoryByName(parsed.category);

      if (!categoryId) {
        categoryId = await EmailParserService.getDefaultExpenseCategory();
      }

      if (!categoryId) {
        console.error('[EmailSync] No category found for transaction');
        return null;
      }

      // Crear descripcion
      const description = [
        parsed.merchant,
        parsed.cardLast4 ? `(****${parsed.cardLast4})` : null,
        parsed.authorizationCode ? `Auth: ${parsed.authorizationCode}` : null,
        '[Importado de Email]'
      ].filter(Boolean).join(' - ');

      // Crear transaccion
      const transaction = await prisma.transaction.create({
        data: {
          userId,
          amount: parsed.amount,
          type: 'EXPENSE',
          description,
          date: new Date(parsed.date),
          category_id: categoryId
        }
      });

      console.log(`[EmailSync] Created transaction ${transaction.id} for ${parsed.amount} ${parsed.currency}`);

      return transaction;

    } catch (error) {
      console.error('[EmailSync] Error creating transaction:', error);
      return null;
    }
  }

  /**
   * Finaliza el log de sincronizacion
   */
  private static async finalizeSyncLog(
    logId: string,
    result: SyncResult,
    status: EmailSyncStatus,
    errorMessage?: string
  ): Promise<void> {
    await prisma.emailSyncLog.update({
      where: { id: logId },
      data: {
        completedAt: new Date(),
        status,
        emailsFound: result.emailsFound,
        emailsProcessed: result.emailsProcessed,
        emailsSkipped: result.emailsSkipped,
        transactionsCreated: result.transactionsCreated,
        errorMessage
      }
    });
  }

  /**
   * Actualiza el estado de la conexion
   */
  private static async updateConnectionStatus(
    connectionId: string,
    status: EmailSyncStatus,
    error?: string
  ): Promise<void> {
    await prisma.emailConnection.update({
      where: { id: connectionId },
      data: {
        lastSyncAt: new Date(),
        lastSyncStatus: status,
        lastSyncError: error || null
      }
    });
  }

  /**
   * Desconecta el email de un usuario
   */
  static async disconnectEmail(userId: string, provider: 'GMAIL' | 'OUTLOOK' = 'GMAIL'): Promise<void> {
    const connection = await prisma.emailConnection.findUnique({
      where: {
        userId_provider: { userId, provider }
      }
    });

    if (connection) {
      // Revocar acceso en Google
      if (provider === 'GMAIL') {
        await GmailService.revokeAccess(connection.accessToken);
      }

      // Eliminar conexion y datos relacionados
      await prisma.emailConnection.delete({
        where: { id: connection.id }
      });
    }
  }

  /**
   * Obtiene el estado de conexion de email de un usuario
   */
  static async getConnectionStatus(userId: string): Promise<any> {
    const connection = await prisma.emailConnection.findFirst({
      where: { userId, isActive: true },
      include: {
        bankFilters: true,
        _count: {
          select: {
            importedEmails: true,
            syncLogs: true
          }
        }
      }
    });

    if (!connection) {
      return { connected: false };
    }

    // Obtener estadisticas
    const stats = await prisma.importedBankEmail.groupBy({
      by: ['status'],
      where: { emailConnectionId: connection.id },
      _count: true
    });

    return {
      connected: true,
      provider: connection.provider,
      email: connection.email,
      lastSyncAt: connection.lastSyncAt,
      lastSyncStatus: connection.lastSyncStatus,
      banksConfigured: connection.bankFilters.length,
      emailsImported: connection._count.importedEmails,
      stats: stats.reduce((acc, s) => ({ ...acc, [s.status]: s._count }), {})
    };
  }

  /**
   * Obtiene las conexiones activas para sincronizar
   */
  static async getActiveConnectionsForSync(): Promise<EmailConnection[]> {
    const now = new Date();

    return prisma.emailConnection.findMany({
      where: {
        isActive: true,
        OR: [
          { lastSyncAt: null },
          {
            lastSyncAt: {
              lt: new Date(now.getTime() - 60 * 60 * 1000) // Hace mas de 1 hora
            }
          }
        ]
      }
    });
  }
}

export default EmailSyncService;
