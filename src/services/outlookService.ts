import { PrismaClient, EmailConnection } from '@prisma/client';
import axios from 'axios';

const prisma = new PrismaClient();

// Configuración de Microsoft OAuth
const MICROSOFT_CLIENT_ID = process.env.MICROSOFT_CLIENT_ID;
const MICROSOFT_CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET;
const MICROSOFT_REDIRECT_URI = process.env.MICROSOFT_REDIRECT_URI || 'https://finzenai-backend-production.up.railway.app/api/email-sync/outlook/callback';

// Scopes necesarios para leer emails de Outlook
const OUTLOOK_SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'https://graph.microsoft.com/Mail.Read'
];

interface OutlookMessage {
  id: string;
  conversationId: string;
  subject: string;
  bodyPreview: string;
  body: {
    contentType: string;
    content: string;
  };
  from: {
    emailAddress: {
      name: string;
      address: string;
    };
  };
  receivedDateTime: string;
  isRead: boolean;
}

interface OutlookListResponse {
  value: OutlookMessage[];
  '@odata.nextLink'?: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  scope: string;
}

interface UserInfoResponse {
  mail?: string;
  userPrincipalName: string;
  displayName: string;
}

export class OutlookService {

  /**
   * Genera la URL de autorización OAuth para Outlook/Microsoft
   */
  static getAuthorizationUrl(userId: string, mobileRedirectUrl?: string): string {
    // Codificamos userId y mobileRedirectUrl en el state
    const stateData = {
      userId,
      mobileRedirectUrl: mobileRedirectUrl || 'finzenai://email-sync/callback'
    };
    const state = Buffer.from(JSON.stringify(stateData)).toString('base64');

    const params = new URLSearchParams({
      client_id: MICROSOFT_CLIENT_ID || '',
      redirect_uri: MICROSOFT_REDIRECT_URI,
      response_type: 'code',
      scope: OUTLOOK_SCOPES.join(' '),
      response_mode: 'query',
      state
    });

    return `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${params.toString()}`;
  }

  /**
   * Intercambia el código de autorización por tokens
   */
  static async exchangeCodeForTokens(code: string): Promise<TokenResponse> {
    const params = new URLSearchParams({
      client_id: MICROSOFT_CLIENT_ID || '',
      client_secret: MICROSOFT_CLIENT_SECRET || '',
      code,
      grant_type: 'authorization_code',
      redirect_uri: MICROSOFT_REDIRECT_URI
    });

    const response = await axios.post(
      'https://login.microsoftonline.com/common/oauth2/v2.0/token',
      params.toString(),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );

    return response.data;
  }

  /**
   * Refresca el access token usando el refresh token
   */
  static async refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
    const params = new URLSearchParams({
      client_id: MICROSOFT_CLIENT_ID || '',
      client_secret: MICROSOFT_CLIENT_SECRET || '',
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    });

    const response = await axios.post(
      'https://login.microsoftonline.com/common/oauth2/v2.0/token',
      params.toString(),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );

    return response.data;
  }

  /**
   * Obtiene el email del usuario autenticado
   */
  static async getUserEmail(accessToken: string): Promise<string> {
    const response = await axios.get<UserInfoResponse>('https://graph.microsoft.com/v1.0/me', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    // Microsoft puede devolver el email en 'mail' o en 'userPrincipalName'
    return response.data.mail || response.data.userPrincipalName;
  }

  /**
   * Verifica si el token es válido y lo refresca si es necesario
   */
  static async ensureValidToken(connection: EmailConnection): Promise<string> {
    const now = new Date();

    // Si el token expira en menos de 5 minutos, refrescarlo
    if (connection.tokenExpiresAt && connection.tokenExpiresAt <= new Date(now.getTime() + 5 * 60 * 1000)) {
      if (!connection.refreshToken) {
        throw new Error('No refresh token available');
      }

      const newTokens = await this.refreshAccessToken(connection.refreshToken);

      // Actualizar tokens en la base de datos
      await prisma.emailConnection.update({
        where: { id: connection.id },
        data: {
          accessToken: newTokens.access_token,
          tokenExpiresAt: new Date(Date.now() + newTokens.expires_in * 1000),
          ...(newTokens.refresh_token && { refreshToken: newTokens.refresh_token })
        }
      });

      return newTokens.access_token;
    }

    return connection.accessToken;
  }

  /**
   * Busca emails bancarios en Outlook usando Microsoft Graph API
   */
  static async searchBankEmails(
    accessToken: string,
    senderEmails: string[],
    subjectKeywords: string[],
    afterDate?: Date,
    maxResults: number = 100
  ): Promise<{ messages: OutlookMessage[] }> {
    // Construir filtro OData para Microsoft Graph
    // Formato: from/emailAddress/address eq 'email@domain.com'
    const senderFilters = senderEmails.map(email =>
      `from/emailAddress/address eq '${email}'`
    ).join(' or ');

    let filter = `(${senderFilters})`;

    if (afterDate) {
      const dateStr = afterDate.toISOString();
      filter += ` and receivedDateTime ge ${dateStr}`;
    }

    try {
      const response = await axios.get<OutlookListResponse>(
        'https://graph.microsoft.com/v1.0/me/messages',
        {
          headers: { Authorization: `Bearer ${accessToken}` },
          params: {
            '$filter': filter,
            '$top': maxResults,
            '$select': 'id,conversationId,subject,bodyPreview,body,from,receivedDateTime,isRead',
            '$orderby': 'receivedDateTime desc'
          }
        }
      );

      return { messages: response.data.value || [] };

    } catch (error: any) {
      // Si el filtro es muy complejo, intentar sin filtro de sender (buscar todos y filtrar después)
      if (error.response?.status === 400) {
        console.warn('[OutlookService] Complex filter failed, fetching recent emails and filtering locally');

        let dateFilter = '';
        if (afterDate) {
          dateFilter = `receivedDateTime ge ${afterDate.toISOString()}`;
        }

        const response = await axios.get<OutlookListResponse>(
          'https://graph.microsoft.com/v1.0/me/messages',
          {
            headers: { Authorization: `Bearer ${accessToken}` },
            params: {
              ...(dateFilter && { '$filter': dateFilter }),
              '$top': maxResults * 2, // Obtener más para compensar el filtrado local
              '$select': 'id,conversationId,subject,bodyPreview,body,from,receivedDateTime,isRead',
              '$orderby': 'receivedDateTime desc'
            }
          }
        );

        // Filtrar localmente por sender
        const filteredMessages = response.data.value.filter(msg =>
          senderEmails.some(email =>
            msg.from.emailAddress.address.toLowerCase() === email.toLowerCase()
          )
        );

        return { messages: filteredMessages.slice(0, maxResults) };
      }

      throw error;
    }
  }

  /**
   * Obtiene el contenido completo de un email
   */
  static async getEmailContent(accessToken: string, messageId: string): Promise<OutlookMessage> {
    const response = await axios.get<OutlookMessage>(
      `https://graph.microsoft.com/v1.0/me/messages/${messageId}`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        params: {
          '$select': 'id,conversationId,subject,bodyPreview,body,from,receivedDateTime,isRead'
        }
      }
    );

    return response.data;
  }

  /**
   * Extrae el cuerpo del email (texto plano)
   */
  static extractEmailBody(message: OutlookMessage): string {
    let body = message.body?.content || message.bodyPreview || '';

    // Si es HTML, limpiar tags
    if (message.body?.contentType === 'html') {
      body = this.stripHtmlTags(body);
    }

    return body;
  }

  /**
   * Extrae el email del remitente
   */
  static getSenderEmail(message: OutlookMessage): string {
    return message.from?.emailAddress?.address || '';
  }

  /**
   * Obtiene el subject del mensaje
   */
  static getSubject(message: OutlookMessage): string {
    return message.subject || '';
  }

  /**
   * Limpia tags HTML del texto
   */
  private static stripHtmlTags(html: string): string {
    return html
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Revoca el acceso de Outlook (desconectar)
   * Nota: Microsoft no tiene un endpoint directo de revocación como Google
   * El usuario debe revocar manualmente desde su cuenta de Microsoft
   */
  static async revokeAccess(accessToken: string): Promise<void> {
    // Microsoft Graph no tiene un endpoint de revocación directo
    // La recomendación es simplemente eliminar los tokens almacenados
    // El usuario puede revocar permisos desde https://account.live.com/consent/Manage
    console.log('[OutlookService] Access revoked (tokens removed from database)');
  }
}

export default OutlookService;
