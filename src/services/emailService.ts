import { Resend } from 'resend';

// Configurar Resend
const resend = new Resend(process.env.RESEND_API_KEY);

// Template HTML personalizado de FinZen AI
const getEmailTemplate = (name: string, token: string, email: string) => {
  return `<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>¡Bienvenido a FinZen AI!</title>
    <style>
        body {
            margin: 0;
            padding: 0;
            font-family: 'Arial', sans-serif;
            background-color: #f4f6f9;
            color: #333;
            line-height: 1.6;
        }
        .email-container {
            max-width: 600px;
            margin: 0 auto;
            background-color: #ffffff;
            border-radius: 10px;
            overflow: hidden;
            box-shadow: 0 4px 12px rgba(0,0,0,0.1);
        }
        .header {
            background-color: #204274;
            padding: 40px 20px;
            text-align: center;
            color: white;
        }
        .header h1 {
            margin: 0;
            font-size: 32px;
            font-weight: bold;
            letter-spacing: 1px;
        }
        .header p {
            margin: 10px 0 0 0;
            font-size: 16px;
            opacity: 0.9;
        }
        .content {
            padding: 40px 30px;
        }
        .welcome-message {
            font-size: 18px;
            margin-bottom: 25px;
            color: #2c3e50;
            text-align: center;
        }
        .benefits-section {
            background-color: #f8f9fa;
            padding: 25px;
            border-radius: 8px;
            margin: 25px 0;
        }
        .benefits-section h3 {
            color: #204274;
            margin-top: 0;
            font-size: 20px;
            text-align: center;
        }
        .benefit-item {
            display: flex;
            align-items: center;
            margin: 15px 0;
            padding: 10px 0;
        }
        .benefit-icon {
            width: 20px;
            height: 20px;
            background-color: #204274;
            border-radius: 50%;
            margin-right: 15px;
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
            font-weight: bold;
            font-size: 12px;
            flex-shrink: 0;
        }
        .confirm-button {
            display: block;
            width: 280px;
            margin: 30px auto;
            padding: 15px;
            background-color: #204274;
            color: white;
            text-decoration: none;
            border-radius: 8px;
            text-align: center;
            font-size: 18px;
            font-weight: bold;
            transition: transform 0.2s;
        }
        .confirm-button:hover {
            transform: translateY(-2px);
        }
        .social-section {
            background-color: #2c3e50;
            color: white;
            padding: 25px;
            text-align: center;
        }
        .social-section h4 {
            margin-bottom: 15px;
            font-size: 18px;
        }
        .social-icons {
            display: flex;
            justify-content: center;
            gap: 15px;
            margin-top: 15px;
        }
        .social-icon {
            width: 40px;
            height: 40px;
            background-color: #204274;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            text-decoration: none;
            color: white;
            font-weight: bold;
            transition: background-color 0.3s;
        }
        .social-icon:hover {
            background-color: #1a3760;
        }
        .footer {
            padding: 20px;
            text-align: center;
            background-color: #f8f9fa;
            color: #6c757d;
            font-size: 14px;
        }
        .footer a {
            color: #204274;
            text-decoration: none;
        }
        .divider {
            height: 2px;
            background-color: #204274;
            margin: 20px 0;
            border: none;
        }
        @media (max-width: 600px) {
            .content {
                padding: 20px 15px;
            }
            .header {
                padding: 30px 15px;
            }
            .header h1 {
                font-size: 28px;
            }
            .confirm-button {
                width: 90%;
            }
        }
    </style>
</head>
<body>
    <div class="email-container">
        <!-- Header -->
        <div class="header">
            <img src="https://i.imgur.com/N1mxVXn.png" width="150"
    style="display: block; margin: 0 auto 20px; border: none; outline: none; text-decoration: none;"
  />
            <p>Tu copiloto financiero</p>
        </div>

        <!-- Content -->
        <div class="content">
            <div class="welcome-message">
                <strong>¡Bienvenido a la revolución de las finanzas inteligentes!</strong>
            </div>

            <p>Hola <strong>${name}</strong>,</p>

            <p>¡Nos emociona tenerte en la familia FinZen AI! Has dado el primer paso hacia una gestión financiera más inteligente, eficiente y orientada a resultados.</p>

            <div class="benefits-section">
                <h3>🚀 Lo que puedes lograr con FinZen AI:</h3>
                
                <div class="benefit-item">
                    <div class="benefit-icon">✓</div>
                    <div><strong>Análisis Financiero Inteligente:</strong> Obtén insights profundos sobre tus patrones de ingresos y gastos</div>
                </div>
                
                <div class="benefit-item">
                    <div class="benefit-icon">✓</div>
                    <div><strong>Planificación Estratégica:</strong> Diseña y monitorea tus metas financieras con precisión</div>
                </div>
                
                <div class="benefit-item">
                    <div class="benefit-icon">✓</div>
                    <div><strong>Optimización Automática:</strong> Recibe recomendaciones personalizadas para maximizar tu patrimonio</div>
                </div>
            </div>

            <hr class="divider">

            <p style="text-align: center; font-size: 16px; color: #2c3e50;">
                <strong>Para comenzar tu viaje hacia la libertad financiera, confirma tu cuenta:</strong>
            </p>

            <a href="${process.env.FRONTEND_URL || 'http://localhost:5173'}/verify-email?token=${token}&email=${email}" class="confirm-button">
                🎯 Confirmar Cuenta y Comenzar
            </a>

            <p style="text-align: center; font-size: 14px; color: #6c757d; margin-top: 20px;">
                Este enlace expirará en 24 horas por seguridad.
            </p>

            <hr class="divider">
        </div>

        <!-- Social Section -->
        <div class="social-section">
            <h4>Mantente conectado con nosotros</h4>
            <p>Síguenos en nuestras redes sociales para tips, estrategias y contenido exclusivo sobre finanzas inteligentes:</p>
            
            <div class="social-icons">
                <a href="#" class="social-icon" title="Instagram">📷</a>
                <a href="#" class="social-icon" title="X (Twitter)">X</a>
            </div>
            
            <p style="font-size: 14px; margin-top: 15px; opacity: 0.9;">
                <em>Próximamente: contenido exclusivo y estrategias avanzadas</em>
            </p>
        </div>

        <!-- Footer -->
        <div class="footer">
            <p>
                <strong>FinZen AI</strong> - Transformando vidas a través de la inteligencia financiera<br>
                <a href="https://finzenai.com">finzenai.com</a> | 
                <a href="mailto:info@finzenai.com">info@finzenai.com</a>
            </p>
            <p style="margin-top: 15px; font-size: 12px;">
                © 2025 FinZen AI. Todos los derechos reservados.<br>
                <a href="https://finzenai.com/privacy">Política de Privacidad</a> | 
                <a href="https://finzenai.com/terms">Términos de Servicio</a> | 
                <a href="https://finzenai.com/unsubscribe?email=${email}">Cancelar suscripción</a>
            </p>
        </div>
    </div>
</body>
</html>`;
};

export const sendVerificationEmail = async (email: string, userId: string, name: string) => {
  try {
    console.log('🔍 Verificando configuración de Resend...');
    console.log('RESEND_API_KEY existe:', !!process.env.RESEND_API_KEY);

    // Verificar si Resend está configurado
    if (!process.env.RESEND_API_KEY) {
      // Modo simulación para desarrollo
      console.log(`[SIMULACIÓN] Email de verificación enviado a ${email} para usuario ${name}`);
      console.log(`[SIMULACIÓN] Enlace: ${process.env.FRONTEND_URL || 'http://localhost:5173'}/verify-email?token=${userId}&email=${email}`);
      return;
    }

    // Envío real con Resend
    console.log('📧 Intentando enviar email real con Resend...');
    const htmlContent = getEmailTemplate(name, userId, email);

    console.log('📤 Enviando email a:', email);
    console.log('📤 Desde: noreply@finzenai.com');

    const { data, error } = await resend.emails.send({
      from: 'FinZen AI <noreply@finzenai.com>',
      to: email,
      subject: '¡Bienvenido a FinZen AI! - Confirma tu cuenta',
      html: htmlContent
    });

    if (error) {
      console.error('❌ Error de Resend:', error);
      throw error;
    }

    console.log(`✅ Verification email sent to ${email}`, data);
  } catch (error) {
    console.error('❌ Error sending verification email:', error);
    // No fallar en ningún entorno, solo simular
    console.log(`[SIMULACIÓN] Email de verificación enviado a ${email} para usuario ${name}`);
    console.log(`[SIMULACIÓN] Enlace: ${process.env.FRONTEND_URL || 'http://localhost:5173'}/verify-email?token=${userId}&email=${email}`);
  }
};

// Template HTML para código de reseteo de contraseña
const getPasswordResetTemplate = (name: string, resetCode: string) => {
  return `<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Recupera tu contraseña - FinZen AI</title>
    <style>
        body {
            margin: 0;
            padding: 0;
            font-family: 'Arial', sans-serif;
            background-color: #f4f6f9;
            color: #333;
            line-height: 1.6;
        }
        .email-container {
            max-width: 600px;
            margin: 0 auto;
            background-color: #ffffff;
            border-radius: 10px;
            overflow: hidden;
            box-shadow: 0 4px 12px rgba(0,0,0,0.1);
        }
        .header {
            background-color: #204274;
            padding: 40px 20px;
            text-align: center;
            color: white;
        }
        .header h1 {
            margin: 0;
            font-size: 28px;
            font-weight: bold;
        }
        .header p {
            margin: 10px 0 0 0;
            font-size: 16px;
            opacity: 0.9;
        }
        .content {
            padding: 40px 30px;
        }
        .reset-code-container {
            background-color: #f8f9fa;
            border: 2px solid #204274;
            border-radius: 12px;
            padding: 30px;
            text-align: center;
            margin: 25px 0;
        }
        .reset-code {
            font-size: 48px;
            font-weight: bold;
            color: #204274;
            letter-spacing: 8px;
            margin: 15px 0;
            font-family: 'Courier New', monospace;
        }
        .code-label {
            font-size: 18px;
            color: #2c3e50;
            margin-bottom: 15px;
            font-weight: 600;
        }
        .expiry-warning {
            background-color: #fff3cd;
            border: 1px solid #ffeaa7;
            border-radius: 8px;
            padding: 15px;
            margin: 20px 0;
            text-align: center;
        }
        .expiry-text {
            color: #856404;
            font-size: 14px;
            font-weight: 600;
        }
        .security-note {
            background-color: #e7f3ff;
            border-left: 4px solid #204274;
            padding: 15px;
            margin: 20px 0;
        }
        .security-text {
            color: #1f4e79;
            font-size: 14px;
            margin: 0;
        }
        .footer {
            padding: 20px;
            text-align: center;
            background-color: #f8f9fa;
            color: #6c757d;
            font-size: 14px;
        }
        .footer a {
            color: #204274;
            text-decoration: none;
        }
        @media (max-width: 600px) {
            .content {
                padding: 20px 15px;
            }
            .reset-code {
                font-size: 36px;
                letter-spacing: 4px;
            }
        }
    </style>
</head>
<body>
    <div class="email-container">
        <!-- Header -->
        <div class="header">
            <h1>🔐 Recupera tu contraseña</h1>
            <p>FinZen AI - Tu copiloto financiero</p>
        </div>

        <!-- Content -->
        <div class="content">
            <p>Hola <strong>${name}</strong>,</p>

            <p>Recibimos una solicitud para restablecer la contraseña de tu cuenta de FinZen AI.</p>

            <div class="reset-code-container">
                <div class="code-label">Tu código de verificación es:</div>
                <div class="reset-code">${resetCode}</div>
                <p style="margin: 10px 0 0 0; font-size: 14px; color: #6c757d;">
                    Ingresa este código en la aplicación para continuar
                </p>
            </div>

            <div class="expiry-warning">
                <div class="expiry-text">
                    ⏰ Este código expirará en 15 minutos por seguridad
                </div>
            </div>

            <div class="security-note">
                <p class="security-text">
                    <strong>🛡️ Nota de seguridad:</strong><br>
                    • No compartas este código con nadie<br>
                    • Si no solicitaste este cambio, ignora este email<br>
                    • Tu contraseña actual sigue siendo válida hasta que la cambies
                </p>
            </div>

            <p style="text-align: center; margin-top: 30px;">
                Si tienes problemas, contáctanos en
                <a href="mailto:support@finzenai.com" style="color: #204274;">support@finzenai.com</a>
            </p>
        </div>

        <!-- Footer -->
        <div class="footer">
            <p>
                <strong>FinZen AI</strong> - Transformando vidas a través de la inteligencia financiera<br>
                <a href="https://finzenai.com">finzenai.com</a>
            </p>
            <p style="margin-top: 15px; font-size: 12px;">
                © 2025 FinZen AI. Todos los derechos reservados.
            </p>
        </div>
    </div>
</body>
</html>`;
};

export const sendPasswordResetEmail = async (email: string, resetCode: string, name?: string) => {
  try {
    console.log('🔍 Verificando configuración de Resend para reset...');

    // Verificar si Resend está configurado
    if (!process.env.RESEND_API_KEY) {
      // Modo simulación para desarrollo
      console.log(`[SIMULACIÓN] Email de reset enviado a ${email}`);
      console.log(`[SIMULACIÓN] Código de 6 dígitos: ${resetCode}`);
      console.log(`[SIMULACIÓN] El código expirará en 15 minutos`);
      return;
    }

    // Envío real con Resend
    console.log('📧 Intentando enviar email de reset con Resend...');
    const htmlContent = getPasswordResetTemplate(name || 'Usuario', resetCode);

    console.log('📤 Enviando email de reset a:', email);
    console.log('📤 Código:', resetCode);

    const { data, error } = await resend.emails.send({
      from: 'FinZen AI <noreply@finzenai.com>',
      to: email,
      subject: '🔐 Código de recuperación - FinZen AI',
      html: htmlContent
    });

    if (error) {
      console.error('❌ Error de Resend en reset:', error);
      throw error;
    }

    console.log(`✅ Password reset email sent to ${email}`, data);
  } catch (error) {
    console.error('❌ Error sending password reset email:', error);
    // No fallar en ningún entorno, solo simular
    console.log(`[SIMULACIÓN] Email de reset enviado a ${email}`);
    console.log(`[SIMULACIÓN] Código de 6 dígitos: ${resetCode}`);
  }
}; 