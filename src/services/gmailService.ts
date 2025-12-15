import { PrismaClient, EmailConnection, EmailSyncStatus } from '@prisma/client';
import axios from 'axios';

const prisma = new PrismaClient();

// Configuracion de Google OAuth
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'https://finzenai-backend-production.up.railway.app/api/email-sync/gmail/callback';

// Scopes necesarios para leer emails
const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/userinfo.email'
];

interface GmailMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  snippet: string;
  payload: {
    headers: Array<{ name: string; value: string }>;
    body?: { data?: string };
    parts?: Array<{
      mimeType: string;
      body?: { data?: string };
    }>;
  };
  internalDate: string;
}

interface GmailListResponse {
  messages: Array<{ id: string; threadId: string }>;
  nextPageToken?: string;
  resultSizeEstimate: number;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  scope: string;
}

export class GmailService {

  /**
   * Genera la URL de autorizacion OAuth para Gmail
   */
  static getAuthorizationUrl(userId: string, mobileRedirectUrl?: string): string {
    // Codificamos userId y mobileRedirectUrl en el state
    const stateData = {
      userId,
      mobileRedirectUrl: mobileRedirectUrl || 'finzenai://email-sync/callback'
    };
    const state = Buffer.from(JSON.stringify(stateData)).toString('base64');

    const params = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID || '',
      redirect_uri: GOOGLE_REDIRECT_URI,
      response_type: 'code',
      scope: GMAIL_SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      state
    });

    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  /**
   * Intercambia el codigo de autorizacion por tokens
   */
  static async exchangeCodeForTokens(code: string): Promise<TokenResponse> {
    const response = await axios.post('https://oauth2.googleapis.com/token', {
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: GOOGLE_REDIRECT_URI
    });

    return response.data;
  }

  /**
   * Refresca el access token usando el refresh token
   */
  static async refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
    const response = await axios.post('https://oauth2.googleapis.com/token', {
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    });

    return response.data;
  }

  /**
   * Obtiene el email del usuario autenticado
   */
  static async getUserEmail(accessToken: string): Promise<string> {
    const response = await axios.get('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    return response.data.email;
  }

  /**
   * Verifica si el token es valido y lo refresca si es necesario
   */
  static async ensureValidToken(connection: EmailConnection): Promise<string> {
    const now = new Date();

    // Si el token expira en menos de 5 minutos, refrescarlo
    if (connection.tokenExpiresAt && connection.tokenExpiresAt <= new Date(now.getTime() + 5 * 60 * 1000)) {
      if (!connection.refreshToken) {
        throw new Error('No refresh token available');
      }

      console.log(`[GmailService] Refreshing token for connection ${connection.id}`);

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
   * Busca emails bancarios en Gmail
   */
  static async searchBankEmails(
    accessToken: string,
    senderEmails: string[],
    subjectKeywords: string[],
    afterDate?: Date,
    maxResults: number = 100
  ): Promise<GmailListResponse> {
    // Construir query de busqueda
    const senderQuery = senderEmails.map(e => `from:${e}`).join(' OR ');
    const subjectQuery = subjectKeywords.map(k => `subject:${k}`).join(' OR ');

    let query = `(${senderQuery})`;
    if (subjectKeywords.length > 0) {
      query += ` (${subjectQuery})`;
    }

    if (afterDate) {
      const dateStr = afterDate.toISOString().split('T')[0].replace(/-/g, '/');
      query += ` after:${dateStr}`;
    }

    console.log(`[GmailService] Search query: ${query}`);

    const response = await axios.get('https://gmail.googleapis.com/gmail/v1/users/me/messages', {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: {
        q: query,
        maxResults
      }
    });

    return response.data;
  }

  /**
   * Obtiene el contenido completo de un email
   */
  static async getEmailContent(accessToken: string, messageId: string): Promise<GmailMessage> {
    const response = await axios.get(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        params: { format: 'full' }
      }
    );

    return response.data;
  }

  /**
   * Extrae el cuerpo del email (HTML o texto plano)
   */
  static extractEmailBody(message: GmailMessage): string {
    let body = '';

    // Intentar obtener el cuerpo del mensaje
    if (message.payload.body?.data) {
      body = Buffer.from(message.payload.body.data, 'base64').toString('utf-8');
    } else if (message.payload.parts) {
      // Buscar en las partes del mensaje
      for (const part of message.payload.parts) {
        if (part.mimeType === 'text/html' && part.body?.data) {
          body = Buffer.from(part.body.data, 'base64').toString('utf-8');
          break;
        }
        if (part.mimeType === 'text/plain' && part.body?.data && !body) {
          body = Buffer.from(part.body.data, 'base64').toString('utf-8');
        }
      }
    }

    // Limpiar HTML tags para obtener texto plano
    return this.stripHtmlTags(body);
  }

  /**
   * Extrae un header especifico del email
   */
  static getHeader(message: GmailMessage, headerName: string): string | undefined {
    const header = message.payload.headers.find(
      h => h.name.toLowerCase() === headerName.toLowerCase()
    );
    return header?.value;
  }

  /**
   * Limpia tags HTML del texto
   */
  private static stripHtmlTags(html: string): string {
    return html
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Revoca el acceso de Gmail (desconectar)
   */
  static async revokeAccess(accessToken: string): Promise<void> {
    try {
      await axios.post(`https://oauth2.googleapis.com/revoke?token=${accessToken}`);
    } catch (error) {
      console.error('[GmailService] Error revoking access:', error);
    }
  }
}

export default GmailService;
