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

/**
 * Pagina de referidos - Landing para enlaces compartidos
 * Detecta el dispositivo y redirige a la tienda correcta
 * También intenta abrir la app si está instalada
 */
router.get('/join', (req: Request, res: Response) => {
  const refCode = req.query.ref as string || '';

  // URLs de las tiendas (actualizar con los IDs reales)
  const APP_STORE_URL = 'https://apps.apple.com/app/finzen-ai/id6740000000'; // TODO: Actualizar con ID real
  const PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=com.jl.alonso.finzenaimobile';

  const html = `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Únete a FinZen AI</title>
  <meta name="description" content="Descarga FinZen AI y toma el control de tus finanzas personales con inteligencia artificial.">

  <!-- Open Graph para compartir en redes -->
  <meta property="og:title" content="Únete a FinZen AI">
  <meta property="og:description" content="Tu copiloto financiero con IA. Obtén 50% de descuento en tu primer mes.">
  <meta property="og:type" content="website">

  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #1e3a8a 0%, #3b82f6 50%, #60a5fa 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .container {
      background: white;
      border-radius: 24px;
      padding: 40px 32px;
      text-align: center;
      max-width: 420px;
      width: 100%;
      box-shadow: 0 25px 80px rgba(0,0,0,0.3);
    }
    .logo {
      width: 80px;
      height: 80px;
      background: linear-gradient(135deg, #2563EB 0%, #1d4ed8 100%);
      border-radius: 20px;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 24px;
      font-size: 40px;
    }
    h1 {
      color: #1F2937;
      font-size: 26px;
      margin-bottom: 12px;
      font-weight: 700;
    }
    .subtitle {
      color: #6B7280;
      font-size: 16px;
      margin-bottom: 24px;
      line-height: 1.5;
    }
    .discount-badge {
      display: inline-block;
      background: linear-gradient(135deg, #F59E0B 0%, #D97706 100%);
      color: white;
      padding: 12px 24px;
      border-radius: 50px;
      font-weight: 700;
      font-size: 18px;
      margin-bottom: 24px;
      box-shadow: 0 4px 15px rgba(245, 158, 11, 0.4);
    }
    .code-container {
      background: #F3F4F6;
      border-radius: 12px;
      padding: 16px;
      margin-bottom: 28px;
    }
    .code-label {
      font-size: 12px;
      color: #6B7280;
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-bottom: 8px;
    }
    .code {
      font-size: 24px;
      font-weight: 700;
      color: #2563EB;
      font-family: 'Courier New', monospace;
      letter-spacing: 2px;
    }
    .features {
      text-align: left;
      margin-bottom: 28px;
    }
    .feature {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 8px 0;
      color: #374151;
      font-size: 14px;
    }
    .feature-icon {
      width: 24px;
      height: 24px;
      background: #EFF6FF;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
    }
    .btn-primary {
      display: block;
      width: 100%;
      background: linear-gradient(135deg, #2563EB 0%, #1d4ed8 100%);
      color: white;
      padding: 18px 32px;
      border-radius: 14px;
      text-decoration: none;
      font-weight: 600;
      font-size: 17px;
      transition: transform 0.2s, box-shadow 0.2s;
      margin-bottom: 12px;
    }
    .btn-primary:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 25px rgba(37, 99, 235, 0.4);
    }
    .btn-secondary {
      display: block;
      width: 100%;
      background: #F3F4F6;
      color: #374151;
      padding: 14px 32px;
      border-radius: 14px;
      text-decoration: none;
      font-weight: 600;
      font-size: 15px;
      transition: background 0.2s;
    }
    .btn-secondary:hover {
      background: #E5E7EB;
    }
    .store-buttons {
      display: none;
    }
    .store-buttons.show {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .spinner {
      width: 24px;
      height: 24px;
      border: 3px solid #E5E7EB;
      border-top-color: #2563EB;
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin: 0 auto 16px;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    .loading-text {
      color: #6B7280;
      font-size: 14px;
    }
    .divider {
      display: flex;
      align-items: center;
      margin: 20px 0;
      color: #9CA3AF;
      font-size: 13px;
    }
    .divider::before, .divider::after {
      content: '';
      flex: 1;
      height: 1px;
      background: #E5E7EB;
    }
    .divider::before { margin-right: 12px; }
    .divider::after { margin-left: 12px; }
    .note {
      font-size: 13px;
      color: #9CA3AF;
      margin-top: 20px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">💰</div>
    <h1>¡Te invitaron a FinZen AI!</h1>
    <p class="subtitle">Tu copiloto financiero con inteligencia artificial</p>

    <div class="discount-badge">🎁 50% OFF tu primer mes</div>

    ${refCode ? `
    <div class="code-container">
      <div class="code-label">Tu código de referido</div>
      <div class="code">${refCode}</div>
    </div>
    ` : ''}

    <div class="features">
      <div class="feature">
        <span class="feature-icon">🤖</span>
        <span>Zenio AI - Tu asistente financiero personal</span>
      </div>
      <div class="feature">
        <span class="feature-icon">📊</span>
        <span>Control total de ingresos y gastos</span>
      </div>
      <div class="feature">
        <span class="feature-icon">🎯</span>
        <span>Metas de ahorro inteligentes</span>
      </div>
      <div class="feature">
        <span class="feature-icon">🔔</span>
        <span>Alertas y recordatorios automáticos</span>
      </div>
    </div>

    <div id="loading">
      <div class="spinner"></div>
      <p class="loading-text">Detectando tu dispositivo...</p>
    </div>

    <div id="storeButtons" class="store-buttons">
      <a href="#" id="primaryBtn" class="btn-primary">
        📱 Descargar FinZen AI
      </a>
      <div class="divider">o descarga desde</div>
      <a href="${APP_STORE_URL}" id="iosBtn" class="btn-secondary">
        🍎 App Store (iPhone)
      </a>
      <a href="${PLAY_STORE_URL}" id="androidBtn" class="btn-secondary">
        🤖 Google Play (Android)
      </a>
    </div>

    <p class="note">
      ${refCode ? `Usa el código <strong>${refCode}</strong> al registrarte` : 'Descarga la app y comienza gratis'}
    </p>
  </div>

  <script>
    const APP_STORE_URL = '${APP_STORE_URL}';
    const PLAY_STORE_URL = '${PLAY_STORE_URL}';
    const APP_SCHEME = '${APP_SCHEME}';
    const REF_CODE = '${refCode}';

    // Detectar dispositivo
    function detectDevice() {
      const ua = navigator.userAgent || navigator.vendor || window.opera;

      if (/iPad|iPhone|iPod/.test(ua) && !window.MSStream) {
        return 'ios';
      }
      if (/android/i.test(ua)) {
        return 'android';
      }
      return 'desktop';
    }

    // Configurar botones según dispositivo
    function setupButtons() {
      const device = detectDevice();
      const primaryBtn = document.getElementById('primaryBtn');
      const iosBtn = document.getElementById('iosBtn');
      const androidBtn = document.getElementById('androidBtn');
      const loading = document.getElementById('loading');
      const storeButtons = document.getElementById('storeButtons');

      // Ocultar loading y mostrar botones
      loading.style.display = 'none';
      storeButtons.classList.add('show');

      if (device === 'ios') {
        primaryBtn.textContent = '🍎 Descargar en App Store';
        primaryBtn.href = APP_STORE_URL;
        iosBtn.style.display = 'none';

        // Intentar abrir la app primero
        tryOpenApp();
      } else if (device === 'android') {
        primaryBtn.textContent = '🤖 Descargar en Google Play';
        primaryBtn.href = PLAY_STORE_URL;
        androidBtn.style.display = 'none';

        // Intentar abrir la app primero
        tryOpenApp();
      } else {
        // Desktop - mostrar ambas opciones
        primaryBtn.style.display = 'none';
        document.querySelector('.divider').style.display = 'none';
      }
    }

    // Intentar abrir la app si está instalada
    function tryOpenApp() {
      const deepLink = APP_SCHEME + '://referral?code=' + REF_CODE;

      // Crear iframe oculto para intentar abrir la app
      const iframe = document.createElement('iframe');
      iframe.style.display = 'none';
      iframe.src = deepLink;
      document.body.appendChild(iframe);

      // Limpiar después de 2 segundos
      setTimeout(function() {
        document.body.removeChild(iframe);
      }, 2000);
    }

    // Ejecutar al cargar
    setTimeout(setupButtons, 800);
  </script>
</body>
</html>
  `;

  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

export default router;
