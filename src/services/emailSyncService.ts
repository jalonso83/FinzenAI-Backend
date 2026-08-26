import { EmailConnection, EmailSyncStatus, ImportedEmailStatus, NotificationType } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { GmailService } from './gmailService';
import { OutlookService } from './outlookService';
import { EmailParserService, ParsedTransaction } from './emailParserService';
import { NotificationService } from './notificationService';
import { recalculateBudgets } from './budgetService';
import { GamificationService } from './gamificationService';
import { encrypt, decrypt } from '../utils/encryption';
import { recordFeatureUsage } from '../lib/featureUsage';

import { logger } from '../utils/logger';
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

    // Crear o actualizar conexion (tokens encriptados con AES-256-GCM)
    const encryptedAccessToken = encrypt(tokens.access_token);
    const encryptedRefreshToken = tokens.refresh_token ? encrypt(tokens.refresh_token) : undefined;

    const connection = await prisma.emailConnection.upsert({
      where: {
        userId_provider: {
          userId,
          provider: 'GMAIL'
        }
      },
      update: {
        email: gmailEmail,
        accessToken: encryptedAccessToken,
        refreshToken: encryptedRefreshToken,
        tokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000),
        isActive: true,
        // Reconectar limpia un estado REVOKED anterior y la devuelve a la cola.
        lastSyncStatus: 'PENDING',
        lastSyncError: null
      },
      create: {
        userId,
        provider: 'GMAIL',
        email: gmailEmail,
        accessToken: encryptedAccessToken,
        refreshToken: encryptedRefreshToken,
        tokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000),
        isActive: true
      }
    });

    // Embudo de Gastos en automático — paso 3 de 3. Se registra aquí y no en
    // el callback HTTP porque este es el punto donde la conexión existe de
    // verdad: si el intercambio de tokens falla, no se llega hasta acá.
    //
    // Y se registra en `feature_usage` aunque la fila de EmailConnection ya lo
    // implique, porque esa fila se BORRA en cascada al bajar de Pro — el
    // historial de quién llegó a conectar solo sobrevive aquí.
    recordFeatureUsage(userId, 'email_sync', 'conecto', { proveedor: 'gmail' });

    // Crear filtros de bancos por defecto según el país del usuario
    const userCountry = this.mapCountryToCode(user?.country || 'República Dominicana');
    await this.createDefaultBankFilters(connection.id, userCountry);

    // ========== GAMIFICACIÓN: Bonus por configurar email sync ==========
    try {
      await GamificationService.dispatchEvent({
        userId,
        eventType: 'email_sync_setup',
        eventData: { provider: 'GMAIL', email: gmailEmail },
        pointsAwarded: 50
      });
      logger.log('[EmailSync] Gamification: email_sync_setup event dispatched for Gmail');
    } catch (gamificationError) {
      logger.error('[EmailSync] Gamification error (non-blocking):', gamificationError);
    }

    this.arrancarPrimeraSincronizacion(userId, 'GMAIL', connection.id);

    return connection;
  }

  /**
   * Conecta la cuenta de Outlook de un usuario
   */
  static async connectOutlook(userId: string, authCode: string): Promise<EmailConnection> {
    // Obtener el país del usuario para filtrar bancos
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { country: true }
    });

    // Intercambiar codigo por tokens
    const tokens = await OutlookService.exchangeCodeForTokens(authCode);

    // Obtener email del usuario de Microsoft
    const outlookEmail = await OutlookService.getUserEmail(tokens.access_token);

    // Crear o actualizar conexion (tokens encriptados con AES-256-GCM)
    const encryptedAccessToken = encrypt(tokens.access_token);
    const encryptedRefreshToken = tokens.refresh_token ? encrypt(tokens.refresh_token) : undefined;

    const connection = await prisma.emailConnection.upsert({
      where: {
        userId_provider: {
          userId,
          provider: 'OUTLOOK'
        }
      },
      update: {
        email: outlookEmail,
        accessToken: encryptedAccessToken,
        refreshToken: encryptedRefreshToken,
        tokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000),
        isActive: true,
        // Reconectar limpia un estado REVOKED anterior y la devuelve a la cola.
        lastSyncStatus: 'PENDING',
        lastSyncError: null
      },
      create: {
        userId,
        provider: 'OUTLOOK',
        email: outlookEmail,
        accessToken: encryptedAccessToken,
        refreshToken: encryptedRefreshToken,
        tokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000),
        isActive: true
      }
    });

    // Paso 3 de 3 del embudo — ver la nota en la rama de Gmail.
    recordFeatureUsage(userId, 'email_sync', 'conecto', { proveedor: 'outlook' });

    // Crear filtros de bancos por defecto según el país del usuario
    const userCountry = this.mapCountryToCode(user?.country || 'República Dominicana');
    await this.createDefaultBankFilters(connection.id, userCountry);

    // ========== GAMIFICACIÓN: Bonus por configurar email sync ==========
    try {
      await GamificationService.dispatchEvent({
        userId,
        eventType: 'email_sync_setup',
        eventData: { provider: 'OUTLOOK', email: outlookEmail },
        pointsAwarded: 50
      });
      logger.log('[EmailSync] Gamification: email_sync_setup event dispatched for Outlook');
    } catch (gamificationError) {
      logger.error('[EmailSync] Gamification error (non-blocking):', gamificationError);
    }

    this.arrancarPrimeraSincronizacion(userId, 'OUTLOOK', connection.id);

    return connection;
  }

  /**
   * Progreso de la sincronización en curso (o de la última terminada).
   *
   * Pensado para que la pantalla de conexión lo consulte cada pocos segundos y
   * pueda mostrar avance real —"revisando 23 de 47"— en vez de una rueda que no
   * dice nada. Devuelve siempre algo: si no hay ninguna corrida, `estado: null`.
   *
   * Es deliberadamente barato: una sola fila, sin joins, para que se pueda
   * consultar cada 2 o 3 segundos sin pesar.
   */
  static async getSyncProgress(userId: string): Promise<{
    estado: 'IN_PROGRESS' | 'SUCCESS' | 'FAILED' | null;
    correosEncontrados: number;
    correosProcesados: number;
    transaccionesCreadas: number;
    terminado: boolean;
  }> {
    const ultima = await prisma.emailSyncLog.findFirst({
      where: { emailConnection: { userId } },
      orderBy: { startedAt: 'desc' },
      select: {
        status: true,
        emailsFound: true,
        emailsProcessed: true,
        transactionsCreated: true,
        completedAt: true,
      },
    });

    if (!ultima) {
      return { estado: null, correosEncontrados: 0, correosProcesados: 0, transaccionesCreadas: 0, terminado: false };
    }

    return {
      estado: ultima.status as 'IN_PROGRESS' | 'SUCCESS' | 'FAILED',
      correosEncontrados: ultima.emailsFound,
      correosProcesados: ultima.emailsProcessed,
      transaccionesCreadas: ultima.transactionsCreated,
      terminado: ultima.status !== 'IN_PROGRESS',
    };
  }

  /**
   * ─── Primera sincronización, disparada al conectar ──────────────────────────
   *
   * Antes de esto, conectar el correo no hacía que entrara nada: la app mostraba
   * "¡Conectado!" y las transacciones no aparecían hasta que el usuario tocara
   * "Sincronizar Todas" a mano o hasta que pasara el scheduler horas después.
   * Es decir, el momento de más ilusión del producto —acabo de darle acceso a mi
   * correo— terminaba en una pantalla vacía. La peor primera impresión posible,
   * y justo la que el rediseño quiere aprovechar.
   *
   * Va SIN await y con su propio catch a propósito: la conexión ya está creada y
   * el usuario ya recibió su respuesta. Si esta corrida falla, el scheduler la
   * recogerá igual en su siguiente pasada — pero el 201 del OAuth no se puede
   * quedar esperando a que terminemos de leer un buzón.
   *
   * El aviso de que terminó ya existe: la notificación EMAIL_SYNC_COMPLETE que
   * dispara el propio flujo de sincronización.
   */
  private static arrancarPrimeraSincronizacion(
    userId: string,
    proveedor: 'GMAIL' | 'OUTLOOK',
    connectionId: string,
  ): void {
    // Solo ESTA conexión, no todas las del usuario. `syncAllUserConnections`
    // aborta entero si encuentra alguna en IN_PROGRESS, así que conectar Gmail y
    // Outlook seguidos habría hecho que la segunda se registrara como fallo
    // cuando en realidad solo estaba esperando su turno.
    void this.syncUserEmails(connectionId)
      .then((result) => {
        logger.log(`[EmailSync] Primera sincronización de ${proveedor} para ${userId}: ${result.transactionsCreated} transacciones`);
        recordFeatureUsage(userId, 'email_sync', 'primera_sync', {
          proveedor,
          transacciones: result.transactionsCreated,
        });
      })
      .catch((error) => {
        // No se le devuelve al usuario: ya tiene su "conectado". Queda en el log
        // y en el próximo pase del scheduler.
        logger.error(`[EmailSync] Falló la primera sincronización de ${proveedor} para ${userId}:`, error);
        recordFeatureUsage(userId, 'email_sync', 'primera_sync_fallo', { proveedor });
      });
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
      logger.warn(`[EmailSync] No supported banks found for country: ${userCountry}`);
      return;
    }

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
      // Obtener conexion con filtros y suscripción del usuario
      const connection = await prisma.emailConnection.findUnique({
        where: { id: connectionId },
        include: {
          bankFilters: { where: { isActive: true } },
          user: {
            include: {
              subscription: true
            }
          }
        }
      });

      if (!connection || !connection.isActive) {
        throw new Error('Email connection not found or inactive');
      }

      // Verificar que el usuario tenga plan PRO (email sync es exclusivo PRO)
      const subscription = connection.user?.subscription;
      const isPro = subscription?.plan === 'PRO' &&
                    (subscription?.status === 'ACTIVE' || subscription?.status === 'TRIALING');

      if (!isPro) {
        logger.log(`[EmailSync] Usuario ${connection.userId} no tiene PRO, saltando sincronización`);
        throw new Error('Email sync requires PRO subscription');
      }

      // Actualizar estado
      await prisma.emailConnection.update({
        where: { id: connectionId },
        data: { lastSyncStatus: 'IN_PROGRESS' }
      });

      // Asegurar token valido según el proveedor
      const isOutlook = connection.provider === 'OUTLOOK';
      const accessToken = isOutlook
        ? await OutlookService.ensureValidToken(connection)
        : await GmailService.ensureValidToken(connection);

      // Recopilar todos los emails de los filtros
      const allSenderEmails: string[] = [];
      const allSubjectKeywords: string[] = [];

      for (const filter of connection.bankFilters) {
        allSenderEmails.push(...filter.senderEmails);
        allSubjectKeywords.push(...filter.subjectKeywords);
      }

      // Verificar si hay emails importados previos
      const importedCount = await prisma.importedBankEmail.count({
        where: { emailConnectionId: connectionId }
      });

      // Si no hay emails importados, buscar ultimos 30 dias (primera sync real)
      // Si ya hay emails, buscar desde la ultima sincronizacion
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const afterDate = importedCount === 0 ? thirtyDaysAgo : (connection.lastSyncAt || thirtyDaysAgo);

      // Buscar emails según el proveedor
      let messages: any[] = [];

      if (isOutlook) {
        const searchResult = await OutlookService.searchBankEmails(
          accessToken,
          [...new Set(allSenderEmails)],
          [...new Set(allSubjectKeywords)],
          afterDate,
          100
        );
        messages = searchResult.messages || [];
      } else {
        const searchResult = await GmailService.searchBankEmails(
          accessToken,
          [...new Set(allSenderEmails)],
          [...new Set(allSubjectKeywords)],
          afterDate,
          100
        );
        messages = searchResult.messages || [];
      }

      result.emailsFound = messages.length;

      // ─── Progreso en vivo ─────────────────────────────────────────────────
      // El total se escribe apenas se conoce, ANTES de procesar nada, para que
      // la app pueda decir "revisando 0 de 47" en vez de un giro sin fondo. Sin
      // esto el usuario solo ve una rueda: la sincronización tarda lo que tarde
      // y no hay forma de saber si avanza o se colgó.
      await prisma.emailSyncLog.update({
        where: { id: syncLog.id },
        data: { emailsFound: messages.length },
      }).catch(() => { /* el progreso nunca puede romper la sincronización */ });

      if (messages.length === 0) {
        result.success = true;
        await this.finalizeSyncLog(syncLog.id, result, 'SUCCESS');
        await this.updateConnectionStatus(connectionId, 'SUCCESS');
        return result;
      }

      // Procesar cada email
      for (const message of messages) {
        try {
          // Verificar si ya fue procesado (usamos gmailMessageId para ambos proveedores por compatibilidad)
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

          // Obtener contenido del email según el proveedor
          let subject: string;
          let from: string;
          let body: string;
          let receivedAt: Date;

          if (isOutlook) {
            const emailContent = await OutlookService.getEmailContent(accessToken, message.id);
            subject = OutlookService.getSubject(emailContent);
            from = OutlookService.getSenderEmail(emailContent);
            body = OutlookService.extractEmailBody(emailContent);
            receivedAt = new Date(emailContent.receivedDateTime);
          } else {
            const emailContent = await GmailService.getEmailContent(accessToken, message.id);
            subject = GmailService.getHeader(emailContent, 'Subject') || '';
            from = GmailService.getHeader(emailContent, 'From') || '';
            body = GmailService.extractEmailBody(emailContent);
            receivedAt = new Date(parseInt(emailContent.internalDate));
          }

          // Determinar el banco
          const bankFilter = connection.bankFilters.find(f =>
            f.senderEmails.some(e => from.toLowerCase().includes(e.toLowerCase()))
          );

          // Guardar email importado (rawContent encriptado)
          const importedEmail = await prisma.importedBankEmail.create({
            data: {
              emailConnectionId: connectionId,
              gmailMessageId: message.id,
              subject,
              senderEmail: from,
              receivedAt,
              rawContent: encrypt(body.substring(0, 5000)),
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
            // Correos omitidos a propósito (no son errores de parseo): pago de
            // tarjeta, transacción declinada/reversada y retiro de efectivo.
            // Antes solo se contemplaba el de pago, así que los otros dos se
            // marcaban FAILED y ensuciaban el reporte de errores del sync.
            const isPaymentSkipped = !!parseResult.error && (
              parseResult.error.includes('PAYMENT_EMAIL_SKIPPED') ||
              parseResult.error.includes('DECLINED_EMAIL_SKIPPED') ||
              parseResult.error.includes('CASH_WITHDRAWAL_SKIPPED')
            );

            await prisma.importedBankEmail.update({
              where: { id: importedEmail.id },
              data: {
                status: isPaymentSkipped ? 'SKIPPED' : 'FAILED',
                errorMessage: parseResult.error || 'Could not parse email',
                processedAt: new Date()
              }
            });

            if (isPaymentSkipped) {
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

          // Progreso cada 5 correos, no en cada uno: con buzones grandes serían
          // cientos de escrituras por sincronización y el avance no se nota más
          // por ir de uno en uno.
          if (result.emailsProcessed % 5 === 0) {
            await prisma.emailSyncLog.update({
              where: { id: syncLog.id },
              data: {
                emailsProcessed: result.emailsProcessed,
                transactionsCreated: result.transactionsCreated,
              },
            }).catch(() => { /* nunca romper la sincronización por el progreso */ });
          }

        } catch (error: any) {
          logger.error(`[EmailSync] Error processing message ${message.id}:`, error);
          result.errors.push(`Error processing ${message.id}: ${error.message}`);
        }
      }

      result.success = true;
      await this.finalizeSyncLog(syncLog.id, result, 'SUCCESS');
      await this.updateConnectionStatus(connectionId, 'SUCCESS');

      // ========== GAMIFICACIÓN: Bonus diario por sync activo ==========
      try {
        // Verificar si ya recibió el bonus hoy antes de despachar
        const hasReceivedToday = await GamificationService.hasReceivedDailySyncBonus(connection.userId);
        if (!hasReceivedToday) {
          await GamificationService.dispatchEvent({
            userId: connection.userId,
            eventType: 'email_sync_daily',
            eventData: {
              connectionId,
              emailsProcessed: result.emailsProcessed,
              transactionsCreated: result.transactionsCreated
            },
            pointsAwarded: 5
          });
          logger.log('[EmailSync] Gamification: email_sync_daily bonus awarded');
        }
      } catch (gamificationError) {
        logger.error('[EmailSync] Gamification error (non-blocking):', gamificationError);
      }

      // Enviar notificación push si se importaron transacciones
      if (result.transactionsCreated > 0 || result.emailsProcessed > 0) {
        try {
          await NotificationService.notifyEmailSyncComplete(
            connection.userId,
            result.transactionsCreated
          );
        } catch (notifyError) {
          logger.error('[EmailSync] Error sending notification:', notifyError);
        }
      }

    } catch (error: any) {
      // El log ahora dice DE QUIÉN es el fallo: antes solo se veía el 400 pelado
      // en Railway y había que ir a la base para saber a qué usuario mirar.
      const quien = await this.describeConnection(connectionId);
      logger.error(`[EmailSync] Sync failed (${quien}):`, error);
      result.errors.push(error.message);

      // Token revocado: el usuario quitó el permiso, cambió la contraseña, etc.
      // Reintentar no lo arregla — solo él puede, volviendo a conectar. Antes
      // esto se marcaba FAILED y el scheduler lo reintentaba cada hora para
      // siempre, sin que el usuario se enterara de que dejó de importar nada.
      if (this.isTokenRevokedError(error)) {
        await this.finalizeSyncLog(syncLog.id, result, 'FAILED', 'Acceso revocado por el proveedor');
        await this.handleRevokedConnection(connectionId);
      } else {
        await this.finalizeSyncLog(syncLog.id, result, 'FAILED', error.message);
        await this.updateConnectionStatus(connectionId, 'FAILED', error.message);
      }
    }

    return result;
  }

  /**
   * ¿El error significa que el proveedor revocó nuestro acceso?
   *
   * Google devuelve 400 con `error: 'invalid_grant'` al intentar refrescar un
   * refresh token muerto. Microsoft usa códigos AADSTS equivalentes. Ojo: un 400
   * genérico NO alcanza — hay que mirar el cuerpo, porque un fallo pasajero de
   * red o un 500 del proveedor sí merecen reintento.
   */
  private static isTokenRevokedError(error: any): boolean {
    const data = error?.response?.data ?? {};
    const codigo = String(data.error || '');
    const detalle = String(data.error_description || error?.message || '');

    if (codigo === 'invalid_grant') return true;                    // Google
    if (/AADSTS(50173|700082|54005|65001)/.test(detalle)) return true; // Microsoft
    if (/token has been expired or revoked/i.test(detalle)) return true;
    if (/refresh token.*(expired|revoked|invalid)/i.test(detalle)) return true;

    // NO agregar aquí `invalid_client`. Ese código NO significa que el usuario
    // revocó nada: significa que NUESTRO client secret está mal, rotado o vacío
    // en el deploy. Tratarlo como revocación tiene un radio de explosión enorme:
    // al rotar el secret en Railway, la siguiente corrida del scheduler marcaría
    // REVOKED a TODAS las conexiones cuyo access token estuviera por vencer, las
    // sacaría de la cola y le mandaría a cada usuario un push de "se desconectó
    // tu correo". Arreglar la variable no lo revierte: cada uno tendría que
    // reconectar a mano. Un fallo de configuración nuestro debe quedar como
    // FAILED y reintentarse, no romperle la conexión al usuario.
    return false;
  }

  /**
   * Marca la conexión como REVOKED y avisa al usuario para que la reconecte.
   * REVOKED (no `isActive: false`) a propósito: así la conexión sigue visible en
   * la app con su aviso de "Reconectar" en vez de desaparecer sin explicación,
   * pero queda fuera de la cola del scheduler.
   */
  private static async handleRevokedConnection(connectionId: string): Promise<void> {
    const connection = await prisma.emailConnection.update({
      where: { id: connectionId },
      data: {
        lastSyncStatus: 'REVOKED',
        lastSyncError: 'Se revocó el acceso a tu correo. Vuelve a conectarlo para seguir importando.'
        // lastSyncAt NO se toca: dejarlo con la fecha del último sync REAL. Si se
        // actualizara, la app mostraría "última sync: hace 1 hora" y el usuario
        // creería que todo va bien mientras hace días que no importa nada.
      },
      select: { userId: true, email: true, provider: true }
    });

    logger.error(`[EmailSync] Acceso revocado para ${connection.email} (user ${connection.userId}). Conexión marcada REVOKED.`);

    try {
      await NotificationService.sendToUser(connection.userId, NotificationType.SYSTEM, {
        title: 'Se desconectó tu correo',
        body: `Perdimos el acceso a ${connection.email}. Vuelve a conectarlo para seguir importando tus gastos automáticamente.`,
        data: { screen: 'EmailSync' }
      });
    } catch (notifyError) {
      logger.error('[EmailSync] No se pudo notificar la revocación:', notifyError);
    }
  }

  /** Identifica la conexión para los logs (email + usuario), best-effort. */
  private static async describeConnection(connectionId: string): Promise<string> {
    try {
      const c = await prisma.emailConnection.findUnique({
        where: { id: connectionId },
        select: { email: true, userId: true }
      });
      return c ? `${c.email} / user ${c.userId}` : connectionId;
    } catch {
      return connectionId;
    }
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

      // Blindaje: un mapeo de comercio viejo puede apuntar a una categoría
      // cancelada (isDefault: false). Si es así, la descartamos y dejamos que
      // el flujo de IA/fallback resuelva una categoría activa.
      if (categoryId) {
        const mappedCategory = await prisma.category.findFirst({
          where: { id: categoryId, isDefault: true, type: 'EXPENSE' },
          select: { id: true }
        });
        if (!mappedCategory) {
          logger.error(`[EmailSync] Mapeo de comercio apunta a categoría inactiva (${categoryId}); usando IA/fallback`);
          categoryId = undefined;
        }
      }

      if (!categoryId) {
        categoryId = await EmailParserService.findCategoryByName(parsed.category);
      }

      if (!categoryId) {
        categoryId = await EmailParserService.getDefaultExpenseCategory();
      }

      if (!categoryId) {
        logger.error('[EmailSync] No category found for transaction');
        return null;
      }

      // Convertir moneda extranjera a la moneda del usuario si es necesario
      let finalAmount = parsed.amount;
      let conversionInfo = '';

      const { ExchangeRateService } = await import('./exchangeRateService');
      const txCurrency = ExchangeRateService.normalizeCurrency(parsed.currency);
      const userCurrency = 'DOP'; // Moneda base de la app

      if (txCurrency && txCurrency !== userCurrency) {
        const conversion = await ExchangeRateService.convert(parsed.amount, txCurrency, userCurrency);
        finalAmount = conversion.amount;
        conversionInfo = ` [${txCurrency} ${parsed.amount} → ${userCurrency} ${finalAmount} @${conversion.rate}]`;
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
      // Extraer solo la fecha (YYYY-MM-DD) y usar mediodía UTC para evitar
      // problemas de zona horaria donde medianoche UTC se convierte al día anterior
      const datePart = parsed.date.split('T')[0];
      const safeDate = new Date(datePart + 'T12:00:00Z');

      const transaction = await prisma.transaction.create({
        data: {
          userId,
          amount: finalAmount,
          type: 'EXPENSE',
          description,
          date: safeDate,
          category_id: categoryId
        }
      });

      // Recalcular presupuesto de la categoría
      // Servicio unificado: mismo camino que el formulario y que Zenio. Antes
      // este archivo tenía su PROPIA copia del recálculo, con su propia lógica
      // de umbrales — dos implementaciones que ya habían divergido.
      await recalculateBudgets(userId, categoryId, transaction.date, { notify: true });

      // ========== GAMIFICACIÓN: Puntos por transacción importada ==========
      try {
        await GamificationService.dispatchEvent({
          userId,
          eventType: 'email_tx_imported',
          eventData: {
            transactionId: transaction.id,
            amount: finalAmount,
            merchant: parsed.merchant
          },
          pointsAwarded: 1
        });
      } catch (gamificationError) {
        logger.error('[EmailSync] Gamification error (non-blocking):', gamificationError);
      }

      return transaction;

    } catch (error) {
      logger.error('[EmailSync] Error creating transaction:', error);
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
   * Desconecta una conexión de email específica
   */
  static async disconnectEmailById(connectionId: string, userId: string): Promise<void> {
    const connection = await prisma.emailConnection.findFirst({
      where: { id: connectionId, userId }
    });

    if (!connection) {
      throw new Error('Conexión no encontrada');
    }

    // Revocar acceso según el proveedor (desencriptar token para la API)
    const plainAccessToken = decrypt(connection.accessToken);
    if (connection.provider === 'GMAIL') {
      await GmailService.revokeAccess(plainAccessToken);
    } else if (connection.provider === 'OUTLOOK') {
      await OutlookService.revokeAccess(plainAccessToken);
    }

    // Eliminar conexion y datos relacionados
    await prisma.emailConnection.delete({
      where: { id: connection.id }
    });
  }

  /**
   * Desconecta el email de un usuario (por proveedor - compatibilidad)
   */
  static async disconnectEmail(userId: string, provider?: 'GMAIL' | 'OUTLOOK'): Promise<void> {
    // Si no se especifica provider, buscar cualquier conexión activa
    const connection = provider
      ? await prisma.emailConnection.findUnique({
          where: { userId_provider: { userId, provider } }
        })
      : await prisma.emailConnection.findFirst({
          where: { userId, isActive: true }
        });

    if (connection) {
      await this.disconnectEmailById(connection.id, userId);
    }
  }

  /**
   * Elimina TODAS las conexiones de email de un usuario
   * Se usa cuando el usuario pierde acceso a PRO (email sync es exclusivo PRO)
   */
  static async deleteAllUserEmailConnections(userId: string): Promise<number> {
    const connections = await prisma.emailConnection.findMany({
      where: { userId }
    });

    if (connections.length === 0) {
      return 0;
    }

    // Revocar acceso para cada conexión (desencriptar token para la API)
    for (const connection of connections) {
      try {
        const plainAccessToken = decrypt(connection.accessToken);
        if (connection.provider === 'GMAIL') {
          await GmailService.revokeAccess(plainAccessToken);
        } else if (connection.provider === 'OUTLOOK') {
          await OutlookService.revokeAccess(plainAccessToken);
        }
      } catch (revokeError) {
        // Continuar aunque falle el revoke (el token puede ya estar inválido)
        logger.warn(`[EmailSync] Error revocando acceso para ${connection.email}:`, revokeError);
      }
    }

    // Eliminar todas las conexiones del usuario
    const result = await prisma.emailConnection.deleteMany({
      where: { userId }
    });

    logger.log(`[EmailSync] Eliminadas ${result.count} conexiones de email para usuario ${userId} (ya no tiene PRO)`);

    return result.count;
  }

  /**
   * Sincroniza todas las conexiones activas de un usuario
   */
  static async syncAllUserConnections(userId: string): Promise<{ results: SyncResult[]; totalTransactions: number }> {
    const connections = await prisma.emailConnection.findMany({
      where: { userId, isActive: true }
    });

    if (connections.length === 0) {
      throw new Error('No hay emails conectados');
    }

    // Verificar que ninguna esté en progreso
    const inProgress = connections.find(c => c.lastSyncStatus === 'IN_PROGRESS');
    if (inProgress) {
      throw new Error('Ya hay una sincronización en curso');
    }

    const results: SyncResult[] = [];
    let totalTransactions = 0;

    for (const connection of connections) {
      const result = await this.syncUserEmails(connection.id);
      results.push(result);
      totalTransactions += result.transactionsCreated;
    }

    return { results, totalTransactions };
  }

  /**
   * Obtiene el estado de conexion de email de un usuario (soporta múltiples conexiones)
   */
  static async getConnectionStatus(userId: string): Promise<any> {
    const connections = await prisma.emailConnection.findMany({
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

    if (connections.length === 0) {
      return {
        connected: false,
        connections: [],
        connectedProviders: []
      };
    }

    // Procesar cada conexión
    const connectionDetails = await Promise.all(
      connections.map(async (connection) => {
        // Obtener estadisticas por conexión
        const stats = await prisma.importedBankEmail.groupBy({
          by: ['status'],
          where: { emailConnectionId: connection.id },
          _count: true
        });

        // Contar transacciones reales creadas
        const transactionsCreated = await prisma.importedBankEmail.count({
          where: {
            emailConnectionId: connection.id,
            status: 'SUCCESS',
            transactionId: { not: null }
          }
        });

        return {
          id: connection.id,
          provider: connection.provider,
          email: connection.email,
          lastSyncAt: connection.lastSyncAt,
          lastSyncStatus: connection.lastSyncStatus,
          banksConfigured: connection.bankFilters.length,
          emailsImported: connection._count.importedEmails,
          importedCount: transactionsCreated,
          stats: stats.reduce((acc, s) => ({ ...acc, [s.status]: s._count }), {})
        };
      })
    );

    // Calcular totales
    const totalImported = connectionDetails.reduce((sum, c) => sum + c.importedCount, 0);
    const connectedProviders = connectionDetails.map(c => c.provider);

    return {
      connected: true,
      connections: connectionDetails,
      connectedProviders,
      totalImported,
      // Mantener compatibilidad con versión anterior (usar primera conexión)
      provider: connectionDetails[0]?.provider,
      email: connectionDetails[0]?.email,
      lastSyncAt: connectionDetails[0]?.lastSyncAt,
      lastSyncStatus: connectionDetails[0]?.lastSyncStatus,
      importedCount: totalImported
    };
  }

  /**
   * Obtiene las conexiones activas para sincronizar
   * SOLO usuarios con plan PRO activo (email sync es función exclusiva PRO)
   */
  static async getActiveConnectionsForSync(): Promise<EmailConnection[]> {
    const now = new Date();

    return prisma.emailConnection.findMany({
      where: {
        isActive: true,
        // Excluir las de acceso revocado: reintentarlas no las arregla (solo el
        // usuario puede, reconectando) y generaban un fallo por hora, para
        // siempre. Al reconectar, el estado vuelve a PENDING y reentra sola.
        lastSyncStatus: { not: 'REVOKED' },
        // Solo sincronizar usuarios con plan PRO activo
        user: {
          subscription: {
            plan: 'PRO',
            status: {
              in: ['ACTIVE', 'TRIALING'] // PRO activo o en trial PRO
            }
          }
        },
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

  // Aquí vivía una copia privada de `recalculateBudgetSpent` que además
  // mandaba sus propias alertas de umbral. Se eliminó el 2026-08-09: era la
  // segunda implementación del mismo cálculo y ya había divergido de la
  // principal (leía el valor anterior de otra forma y no aplicaba el límite
  // de plan). Todo pasa ahora por services/budgetService.ts.

}

export default EmailSyncService;
