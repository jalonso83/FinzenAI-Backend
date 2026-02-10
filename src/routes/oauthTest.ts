import { Router, Request, Response } from 'express';

const router: ReturnType<typeof Router> = Router();

/**
 * OAuth Test Page for Google Verification
 * This is a temporary page that allows Google's verification team
 * to test the Gmail OAuth consent screen flow.
 *
 * GET /oauth-test
 */
router.get('/oauth-test', (req: Request, res: Response) => {
  const baseUrl = process.env.BACKEND_URL || `${req.protocol}://${req.get('host')}`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>FinZen AI - OAuth Test</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f7fa; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .container { background: white; border-radius: 16px; box-shadow: 0 4px 24px rgba(0,0,0,0.1); padding: 40px; max-width: 480px; width: 90%; }
    .logo { text-align: center; margin-bottom: 24px; }
    .logo h1 { color: #2563EB; font-size: 28px; }
    .logo p { color: #64748b; font-size: 14px; margin-top: 4px; }
    .section { margin-bottom: 24px; }
    .section h2 { color: #1e293b; font-size: 18px; margin-bottom: 12px; }
    .section p { color: #64748b; font-size: 14px; line-height: 1.5; margin-bottom: 12px; }
    label { display: block; color: #374151; font-size: 14px; font-weight: 500; margin-bottom: 6px; }
    input { width: 100%; padding: 10px 14px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 14px; margin-bottom: 16px; }
    input:focus { outline: none; border-color: #2563EB; box-shadow: 0 0 0 3px rgba(37,99,235,0.1); }
    .btn { width: 100%; padding: 12px; border: none; border-radius: 8px; font-size: 16px; font-weight: 600; cursor: pointer; transition: all 0.2s; }
    .btn-primary { background: #2563EB; color: white; }
    .btn-primary:hover { background: #1d4ed8; }
    .btn-primary:disabled { background: #93c5fd; cursor: not-allowed; }
    .btn-gmail { background: #ea4335; color: white; margin-top: 8px; }
    .btn-gmail:hover { background: #dc2626; }
    .btn-gmail:disabled { background: #fca5a5; cursor: not-allowed; }
    .status { padding: 12px; border-radius: 8px; margin-bottom: 16px; font-size: 14px; display: none; }
    .status.success { display: block; background: #dcfce7; color: #166534; border: 1px solid #bbf7d0; }
    .status.error { display: block; background: #fef2f2; color: #991b1b; border: 1px solid #fecaca; }
    .status.info { display: block; background: #eff6ff; color: #1e40af; border: 1px solid #bfdbfe; }
    .hidden { display: none; }
    .step { background: #f8fafc; border-radius: 8px; padding: 16px; margin-bottom: 16px; border-left: 4px solid #2563EB; }
    .step h3 { color: #1e293b; font-size: 15px; margin-bottom: 6px; }
    .step p { color: #64748b; font-size: 13px; margin: 0; }
    .user-info { background: #f0fdf4; border-radius: 8px; padding: 12px; margin-bottom: 16px; }
    .user-info p { color: #166534; font-size: 14px; margin: 0; }
    .instructions { background: #fffbeb; border-radius: 8px; padding: 16px; margin-bottom: 24px; border: 1px solid #fde68a; }
    .instructions h3 { color: #92400e; font-size: 14px; margin-bottom: 8px; }
    .instructions ol { color: #92400e; font-size: 13px; padding-left: 20px; line-height: 1.8; }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">
      <h1>FinZen AI</h1>
      <p>OAuth Verification Test Page</p>
    </div>

    <div class="instructions">
      <h3>Instructions for Google Verification Team:</h3>
      <ol>
        <li>Log in using the demo credentials below</li>
        <li>After login, click "Connect Gmail" to see the OAuth consent screen</li>
        <li>The app requests <strong>gmail.readonly</strong> and <strong>userinfo.email</strong> scopes</li>
        <li>These scopes are used to read bank statement notification emails for automatic financial tracking</li>
      </ol>
    </div>

    <!-- Step 1: Login -->
    <div id="login-section">
      <div class="step">
        <h3>Step 1: Log in to FinZen AI</h3>
        <p>Use the demo account credentials to authenticate</p>
      </div>

      <div id="login-status" class="status"></div>

      <form id="login-form">
        <label for="email">Email</label>
        <input type="email" id="email" name="email" placeholder="Enter demo email" required>

        <label for="password">Password</label>
        <input type="password" id="password" name="password" placeholder="Enter demo password" required>

        <button type="submit" class="btn btn-primary" id="login-btn">Log In</button>
      </form>
    </div>

    <!-- Step 2: Connect Gmail -->
    <div id="gmail-section" class="hidden">
      <div class="step">
        <h3>Step 2: Connect Gmail Account</h3>
        <p>Click the button below to initiate the Gmail OAuth flow. You will be redirected to Google's consent screen.</p>
      </div>

      <div id="gmail-status" class="status"></div>

      <div id="user-info" class="user-info">
        <p>Logged in as: <strong id="user-name"></strong> (<span id="user-email"></span>)</p>
      </div>

      <button class="btn btn-gmail" id="gmail-btn" onclick="connectGmail()">
        Connect Gmail Account
      </button>

      <p style="color: #64748b; font-size: 12px; margin-top: 12px; text-align: center;">
        This will redirect you to Google's OAuth consent screen where you can authorize read-only access to your Gmail.
      </p>
    </div>
  </div>

  <script>
    const API_BASE = '${baseUrl}/api';
    let authToken = null;

    document.getElementById('login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = document.getElementById('login-btn');
      const status = document.getElementById('login-status');

      btn.disabled = true;
      btn.textContent = 'Logging in...';
      status.className = 'status';
      status.style.display = 'none';

      const email = document.getElementById('email').value;
      const password = document.getElementById('password').value;

      try {
        const response = await fetch(API_BASE + '/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password })
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.message || 'Login failed');
        }

        authToken = data.token;

        // Show user info
        document.getElementById('user-name').textContent = data.user.name;
        document.getElementById('user-email').textContent = data.user.email;

        // Switch to Gmail section
        document.getElementById('login-section').classList.add('hidden');
        document.getElementById('gmail-section').classList.remove('hidden');

      } catch (err) {
        status.className = 'status error';
        status.textContent = 'Login failed: ' + err.message;
        status.style.display = 'block';
        btn.disabled = false;
        btn.textContent = 'Log In';
      }
    });

    async function connectGmail() {
      const btn = document.getElementById('gmail-btn');
      const status = document.getElementById('gmail-status');

      btn.disabled = true;
      btn.textContent = 'Connecting...';
      status.className = 'status';
      status.style.display = 'none';

      try {
        // Use a web redirect URL instead of mobile deep link
        const successUrl = encodeURIComponent('${baseUrl}/oauth-test/success');

        const response = await fetch(
          API_BASE + '/email-sync/gmail/auth-url?mobileRedirectUrl=' + successUrl,
          {
            headers: { 'Authorization': 'Bearer ' + authToken }
          }
        );

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.message || 'Failed to get auth URL');
        }

        // Show info before redirect
        status.className = 'status info';
        status.textContent = 'Redirecting to Google OAuth consent screen...';
        status.style.display = 'block';

        // Redirect to Google OAuth consent screen
        setTimeout(() => {
          window.location.href = data.authUrl;
        }, 1000);

      } catch (err) {
        status.className = 'status error';
        status.textContent = 'Error: ' + err.message;
        status.style.display = 'block';
        btn.disabled = false;
        btn.textContent = 'Connect Gmail Account';
      }
    }
  </script>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html');
  return res.send(html);
});

/**
 * OAuth Test Success Page
 * The Gmail callback redirects here after successful authorization.
 *
 * GET /oauth-test/success
 */
router.get('/oauth-test/success', (req: Request, res: Response) => {
  const { success, email, error } = req.query;

  const isSuccess = success === 'true';
  const title = isSuccess ? 'Gmail Connected Successfully' : 'Connection Failed';
  const message = isSuccess
    ? `Gmail account (${email || 'unknown'}) has been successfully connected to FinZen AI.`
    : `Failed to connect Gmail: ${error || 'Unknown error'}`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>FinZen AI - ${title}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f7fa; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .container { background: white; border-radius: 16px; box-shadow: 0 4px 24px rgba(0,0,0,0.1); padding: 40px; max-width: 480px; width: 90%; text-align: center; }
    .icon { font-size: 64px; margin-bottom: 16px; }
    h1 { color: ${isSuccess ? '#166534' : '#991b1b'}; font-size: 22px; margin-bottom: 12px; }
    p { color: #64748b; font-size: 14px; line-height: 1.6; margin-bottom: 24px; }
    .detail { background: ${isSuccess ? '#f0fdf4' : '#fef2f2'}; border-radius: 8px; padding: 16px; margin-bottom: 24px; }
    .detail p { color: ${isSuccess ? '#166534' : '#991b1b'}; margin: 0; }
    .info { background: #eff6ff; border-radius: 8px; padding: 16px; }
    .info p { color: #1e40af; font-size: 13px; margin: 0; }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">${isSuccess ? '&#9989;' : '&#10060;'}</div>
    <h1>${title}</h1>
    <div class="detail">
      <p>${message}</p>
    </div>
    <div class="info">
      <p><strong>How this feature works in FinZen AI:</strong><br>
      The app uses read-only Gmail access to scan for bank statement notification emails
      and automatically extract transaction data for financial tracking.
      No emails are modified or deleted.</p>
    </div>
  </div>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html');
  return res.send(html);
});

export default router;
