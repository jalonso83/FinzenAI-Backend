import { Router, Request, Response } from 'express';
import type { Router as RouterType } from 'express';

const router: RouterType = Router();

// Configuracion de Apple Universal Links
const APPLE_TEAM_ID = 'PK4462U2Y4';
const APP_BUNDLE_ID = 'com.jl.alonso.finzenaimobile';
const APP_SCHEME = 'finzenai';

/**
 * Apple App Site Association
 * Requerido para Universal Links en iOS
 * Debe estar en: /.well-known/apple-app-site-association
 */
router.get('/.well-known/apple-app-site-association', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'application/json');
  res.json({
    applinks: {
      apps: [],
      details: [
        {
          appIDs: [`${APPLE_TEAM_ID}.${APP_BUNDLE_ID}`],
          components: [
            {
              '/': '/checkout/*',
              comment: 'Checkout success and cancel pages'
            }
          ]
        }
      ]
    }
  });
});

/**
 * Pagina de exito del checkout
 * Stripe redirige aqui despues de un pago exitoso
 * Universal Links abrira la app automaticamente
 * Si falla, muestra pagina web con boton para abrir la app
 */
router.get('/checkout/success', (req: Request, res: Response) => {
  const sessionId = req.query.session_id as string || '';

  const html = `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Pago Exitoso - FinZen</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .container {
      background: white;
      border-radius: 24px;
      padding: 40px;
      text-align: center;
      max-width: 400px;
      width: 100%;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
    }
    .icon {
      width: 80px;
      height: 80px;
      background: #10B981;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 24px;
    }
    .icon svg {
      width: 40px;
      height: 40px;
      color: white;
    }
    h1 {
      color: #1F2937;
      font-size: 24px;
      margin-bottom: 12px;
    }
    p {
      color: #6B7280;
      font-size: 16px;
      margin-bottom: 32px;
      line-height: 1.5;
    }
    .btn {
      display: inline-block;
      background: #F59E0B;
      color: white;
      padding: 16px 32px;
      border-radius: 12px;
      text-decoration: none;
      font-weight: 600;
      font-size: 16px;
      transition: transform 0.2s, box-shadow 0.2s;
    }
    .btn:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 20px rgba(245, 158, 11, 0.4);
    }
    .note {
      margin-top: 24px;
      font-size: 14px;
      color: #9CA3AF;
    }
    .spinner {
      width: 20px;
      height: 20px;
      border: 2px solid #E5E7EB;
      border-top-color: #F59E0B;
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin: 0 auto 16px;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    .loading {
      color: #6B7280;
      font-size: 14px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">
      <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7"></path>
      </svg>
    </div>
    <h1>¡Pago Exitoso!</h1>
    <p>Tu suscripcion Premium ha sido activada. Disfruta de todas las funcionalidades sin limites.</p>

    <div id="loading">
      <div class="spinner"></div>
      <p class="loading">Abriendo FinZen...</p>
    </div>

    <a href="${APP_SCHEME}://checkout/success?session_id=${sessionId}" class="btn" id="openApp" style="display: none;">
      Abrir FinZen
    </a>

    <p class="note">Si la app no se abre automaticamente, toca el boton de arriba.</p>
  </div>

  <script>
    // Intentar abrir la app automaticamente
    const appUrl = '${APP_SCHEME}://checkout/success?session_id=${sessionId}';

    // Mostrar boton despues de 2 segundos si la app no se abrio
    setTimeout(function() {
      document.getElementById('loading').style.display = 'none';
      document.getElementById('openApp').style.display = 'inline-block';
    }, 2000);

    // Intentar abrir la app
    window.location.href = appUrl;
  </script>
</body>
</html>
  `;

  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

/**
 * Pagina de cancelacion del checkout
 * Stripe redirige aqui si el usuario cancela el pago
 */
router.get('/checkout/cancel', (req: Request, res: Response) => {
  const html = `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Pago Cancelado - FinZen</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .container {
      background: white;
      border-radius: 24px;
      padding: 40px;
      text-align: center;
      max-width: 400px;
      width: 100%;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
    }
    .icon {
      width: 80px;
      height: 80px;
      background: #F3F4F6;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 24px;
    }
    .icon svg {
      width: 40px;
      height: 40px;
      color: #6B7280;
    }
    h1 {
      color: #1F2937;
      font-size: 24px;
      margin-bottom: 12px;
    }
    p {
      color: #6B7280;
      font-size: 16px;
      margin-bottom: 32px;
      line-height: 1.5;
    }
    .btn {
      display: inline-block;
      background: #6B7280;
      color: white;
      padding: 16px 32px;
      border-radius: 12px;
      text-decoration: none;
      font-weight: 600;
      font-size: 16px;
      transition: transform 0.2s, box-shadow 0.2s;
    }
    .btn:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 20px rgba(107, 114, 128, 0.4);
    }
    .note {
      margin-top: 24px;
      font-size: 14px;
      color: #9CA3AF;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">
      <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
      </svg>
    </div>
    <h1>Pago Cancelado</h1>
    <p>No se realizo ningun cargo a tu tarjeta. Puedes intentar de nuevo cuando quieras.</p>

    <a href="${APP_SCHEME}://checkout/cancel" class="btn">
      Volver a FinZen
    </a>

    <p class="note">Siempre puedes mejorar tu plan desde la app.</p>
  </div>

  <script>
    // Intentar abrir la app automaticamente despues de 1 segundo
    setTimeout(function() {
      window.location.href = '${APP_SCHEME}://checkout/cancel';
    }, 1000);
  </script>
</body>
</html>
  `;

  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

export default router;
