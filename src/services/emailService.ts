// eslint-disable-next-line @typescript-eslint/no-var-requires
const sgMail = require('@sendgrid/mail');

// Configurar SendGrid
sgMail.setApiKey(process.env.SENDGRID_API_KEY!);

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
            <img src="http://cdn.mcauto-images-production.sendgrid.net/a3cd1c1f26183c37/7c61e557-f2f9-4865-9687-7c5b75cfeee2/3592x996.png" width="150"
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

            <a href="http://localhost:5173/verify-email?token=${token}&email=${email}" class="confirm-button">
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
    // Verificar si SendGrid está configurado
    if (!process.env.SENDGRID_API_KEY || process.env.SENDGRID_API_KEY === 'SG.placeholder_key_for_development') {
      // Modo simulación para desarrollo
      console.log(`[SIMULACIÓN] Email de verificación enviado a ${email} para usuario ${name}`);
      console.log(`[SIMULACIÓN] Enlace: http://localhost:5173/verify-email?token=${userId}&email=${email}`);
      return;
    }

    // Envío real con SendGrid
    const htmlContent = getEmailTemplate(name, userId, email);
    const msg = {
      to: email,
      from: process.env.FROM_EMAIL!,
      subject: '¡Bienvenido a FinZen AI! - Confirma tu cuenta',
      html: htmlContent
    };

    await sgMail.send(msg);
    console.log(`✅ Verification email sent to ${email}`);
  } catch (error) {
    console.error('❌ Error sending verification email:', error);
    // En desarrollo, no fallar si SendGrid no está configurado
    if (process.env.NODE_ENV === 'development') {
      console.log(`[SIMULACIÓN] Email de verificación enviado a ${email} para usuario ${name}`);
      console.log(`[SIMULACIÓN] Enlace: http://localhost:5173/verify-email?token=${userId}&email=${email}`);
    } else {
      throw new Error('Failed to send verification email');
    }
  }
};

export const sendPasswordResetEmail = async (email: string, resetToken: string) => {
  try {
    // TEMPORALMENTE DESHABILITADO
    console.log(`[SIMULACIÓN] Email de reset enviado a ${email}`);
    
    // TODO: Implementar cuando SendGrid esté instalado
  } catch (error) {
    console.error('Error sending password reset email:', error);
    throw new Error('Failed to send password reset email');
  }
}; 