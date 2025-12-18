import { PrismaClient, EmailConnection, EmailSyncStatus, ImportedEmailStatus } from '@prisma/client';
import { GmailService } from './gmailService';
import { EmailParserService, ParsedTransaction } from './emailParserService';
import { NotificationService } from './notificationService';

const prisma = new PrismaClient();

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
    // Obtener el país del usuario para filtrar bancos
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { country: true }
    });

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

    // Crear filtros de bancos por defecto según el país del usuario
    const userCountry = this.mapCountryToCode(user?.country || 'República Dominicana');
    await this.createDefaultBankFilters(connection.id, userCountry);

    return connection;
  }

  /**
   * Mapea el nombre del país al código ISO
   */
  private static mapCountryToCode(country: string): string {
    const countryMap: Record<string, string> = {
      'República Dominicana': 'DO',
      'Republica Dominicana': 'DO',
      'Dominican Republic': 'DO',
      'Mexico': 'MX',
      'México': 'MX',
      'Colombia': 'CO',
      'Estados Unidos': 'US',
      'United States': 'US',
      'España': 'ES',
      'Spain': 'ES',
      'Puerto Rico': 'PR',
      'Argentina': 'AR',
      'Chile': 'CL',
      'Peru': 'PE',
      'Perú': 'PE',
      'Venezuela': 'VE',
      'Ecuador': 'EC',
      'Guatemala': 'GT',
      'Honduras': 'HN',
      'El Salvador': 'SV',
      'Nicaragua': 'NI',
      'Costa Rica': 'CR',
      'Panama': 'PA',
      'Panamá': 'PA'
    };

    return countryMap[country] || 'DO'; // Default to DO if not found
  }

  /**
   * Crea filtros de bancos por defecto desde la tabla SupportedBank
   */
  private static async createDefaultBankFilters(connectionId: string, userCountry: string = 'DO'): Promise<void> {
    // Obtener bancos soportados desde la base de datos
    const supportedBanks = await prisma.supportedBank.findMany({
      where: {
        isActive: true,
        country: userCountry
      }
    });

    if (supportedBanks.length === 0) {
      console.warn(`[EmailSync] No supported banks found for country: ${userCountry}`);
      return;
    }

    console.log(`[EmailSync] Creating filters for ${supportedBanks.length} banks in ${userCountry}`);

    for (const bank of supportedBanks) {
      await prisma.bankEmailFilter.upsert({
        where: {
          id: `${connectionId}-${bank.name.replace(/\s/g, '-').toLowerCase()}`
        },
        update: {
          senderEmails: bank.senderEmails,
          subjectKeywords: bank.subjectPatterns
        },
        create: {
          id: `${connectionId}-${bank.name.replace(/\s/g, '-').toLowerCase()}`,
          emailConnectionId: connectionId,
          bankName: bank.name,
          senderEmails: bank.senderEmails,
          subjectKeywords: bank.subjectPatterns
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

      // Verificar si hay emails importados previos
      const importedCount = await prisma.importedBankEmail.count({
        where: { emailConnectionId: connectionId }
      });

      // Si no hay emails importados, buscar ultimos 30 dias (primera sync real)
      // Si ya hay emails, buscar desde la ultima sincronizacion
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const afterDate = importedCount === 0 ? thirtyDaysAgo : (connection.lastSyncAt || thirtyDaysAgo);

      console.log(`[EmailSync] Imported emails count: ${importedCount}`);
      console.log(`[EmailSync] Searching emails after: ${afterDate.toISOString()}`);

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

          // Parsear con AI (incluye sistema de aprendizaje de mapeos)
          const parseResult = await EmailParserService.parseEmailContent(
            body,
            subject,
            bankFilter?.bankName,
            connection.user.country,
            connection.userId  // Para buscar mapeos personalizados del usuario
          );

          if (!parseResult.success || !parseResult.transaction) {
            // Verificar si es un email de pago de tarjeta (saltado intencionalmente)
            const isPaymentSkipped = parseResult.error?.includes('PAYMENT_EMAIL_SKIPPED');

            await prisma.importedBankEmail.update({
              where: { id: importedEmail.id },
              data: {
                status: isPaymentSkipped ? 'SKIPPED' : 'FAILED',
                errorMessage: parseResult.error || 'Could not parse email',
                processedAt: new Date()
              }
            });

            if (isPaymentSkipped) {
              console.log(`[EmailSync] Skipped payment email: ${subject}`);
              result.emailsSkipped++;
            } else {
              result.errors.push(`Failed to parse email ${message.id}: ${parseResult.error}`);
            }
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

      // Enviar notificación push si se importaron transacciones
      if (result.transactionsCreated > 0 || result.emailsProcessed > 0) {
        try {
          await NotificationService.notifyEmailSyncComplete(
            connection.userId,
            result.transactionsCreated
          );
        } catch (notifyError) {
          console.error('[EmailSync] Error sending notification:', notifyError);
        }
      }

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
      // Usar categoryId del mapeo si ya viene, sino buscar por nombre
      let categoryId = parsed.categoryId;

      if (!categoryId) {
        categoryId = await EmailParserService.findCategoryByName(parsed.category);
      }

      if (!categoryId) {
        categoryId = await EmailParserService.getDefaultExpenseCategory();
      }

      if (!categoryId) {
        console.error('[EmailSync] No category found for transaction');
        return null;
      }

      // Log del origen de la categorización
      if (parsed.categorySource) {
        console.log(`[EmailSync] Categoría asignada por: ${parsed.categorySource} -> ${parsed.category}`);
      }

      // Convertir USD a RD$ si es necesario
      let finalAmount = parsed.amount;
      let conversionInfo = '';

      if (parsed.currency === 'USD' || parsed.currency === 'US$') {
        const { ExchangeRateService } = await import('./exchangeRateService');
        const conversion = await ExchangeRateService.convertUsdToDop(parsed.amount);
        finalAmount = conversion.amountDop;
        conversionInfo = ` [USD ${parsed.amount} → RD$ ${finalAmount} @${conversion.rate}]`;
        console.log(`[EmailSync] Converted USD ${parsed.amount} to RD$ ${finalAmount} (rate: ${conversion.rate})`);
      }

      // Crear descripcion
      const description = [
        parsed.merchant,
        parsed.cardLast4 ? `(****${parsed.cardLast4})` : null,
        parsed.authorizationCode ? `Auth: ${parsed.authorizationCode}` : null,
        '[Importado de Email]',
        conversionInfo || null
      ].filter(Boolean).join(' - ');

      // Crear transaccion (siempre en RD$)
      const transaction = await prisma.transaction.create({
        data: {
          userId,
          amount: finalAmount,
          type: 'EXPENSE',
          description,
          date: new Date(parsed.date),
          category_id: categoryId
        }
      });

      console.log(`[EmailSync] Created transaction ${transaction.id} for ${finalAmount} RD$${parsed.currency === 'USD' ? ` (original: ${parsed.amount} USD)` : ''}`);

      // Recalcular presupuesto de la categoría
      await this.recalculateBudgetSpent(userId, categoryId, transaction.date);

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

    // Contar transacciones REALES creadas desde emails (status SUCCESS con transactionId)
    const transactionsCreated = await prisma.importedBankEmail.count({
      where: {
        emailConnectionId: connection.id,
        status: 'SUCCESS',
        transactionId: { not: null }
      }
    });

    return {
      connected: true,
      provider: connection.provider,
      email: connection.email,
      lastSyncAt: connection.lastSyncAt,
      lastSyncStatus: connection.lastSyncStatus,
      banksConfigured: connection.bankFilters.length,
      emailsImported: connection._count.importedEmails,
      importedCount: transactionsCreated, // Transacciones reales creadas
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

  /**
   * Recalcula el gasto de presupuestos afectados por una transacción
   */
  private static async recalculateBudgetSpent(
    userId: string,
    categoryId: string,
    date: Date
  ): Promise<void> {
    try {
      // Buscar presupuestos activos de la categoría cuyo período incluya la fecha
      const budgets = await prisma.budget.findMany({
        where: {
          user_id: userId,
          category_id: categoryId,
          is_active: true,
          start_date: { lte: date },
          end_date: { gte: date }
        },
        include: {
          user: {
            select: { currency: true }
          }
        }
      });

      for (const budget of budgets) {
        // Obtener el gasto anterior para comparar
        const previousSpent = Number(budget.spent) || 0;

        // Sumar todas las transacciones de gasto de esa categoría y período
        const spent = await prisma.transaction.aggregate({
          _sum: { amount: true },
          where: {
            userId,
            category_id: categoryId,
            type: 'EXPENSE',
            date: {
              gte: budget.start_date,
              lte: budget.end_date
            }
          }
        });

        const newSpent = spent._sum.amount || 0;

        await prisma.budget.update({
          where: { id: budget.id },
          data: { spent: newSpent }
        });

        console.log(`[EmailSync] Updated budget ${budget.id} spent: ${newSpent}`);

        // Verificar si se debe enviar notificación de alerta
        const budgetAmount = Number(budget.amount);
        const alertThreshold = Number(budget.alert_percentage) || 80;
        const previousPercentage = (previousSpent / budgetAmount) * 100;
        const newPercentage = (newSpent / budgetAmount) * 100;
        const currency = budget.user?.currency || 'RD$';

        // Si cruzamos el umbral de alerta (antes estaba debajo, ahora está encima)
        if (previousPercentage < alertThreshold && newPercentage >= alertThreshold && newPercentage < 100) {
          try {
            await NotificationService.notifyBudgetAlert(
              userId,
              budget.name,
              Math.round(newPercentage),
              budgetAmount - newSpent,
              currency
            );
            console.log(`[EmailSync] Sent budget alert notification for ${budget.name}`);
          } catch (notifyError) {
            console.error('[EmailSync] Error sending budget alert:', notifyError);
          }
        }

        // Si el presupuesto fue excedido (antes estaba debajo del 100%, ahora está encima)
        if (previousPercentage < 100 && newPercentage >= 100) {
          try {
            await NotificationService.notifyBudgetExceeded(
              userId,
              budget.name,
              newSpent - budgetAmount,
              currency
            );
            console.log(`[EmailSync] Sent budget exceeded notification for ${budget.name}`);
          } catch (notifyError) {
            console.error('[EmailSync] Error sending budget exceeded:', notifyError);
          }
        }
      }
    } catch (error) {
      console.error('[EmailSync] Error recalculating budget:', error);
    }
  }
}

export default EmailSyncService;
