// ═══════════════════════════════════════════════════════════
// SERVICIO DE EMAIL - SYA TORTILLERIAS
// Usando Nodemailer para envío de emails transaccionales
// ═══════════════════════════════════════════════════════════

const nodemailer = require('nodemailer');

// Configurar transporter con variables de entorno
const createTransporter = () => {
    const port = parseInt(process.env.EMAIL_PORT || '465');
    const secure = port === 465; // SSL para 465, STARTTLS para 587

    console.log(`[EmailService] Configurando SMTP: host=${process.env.EMAIL_HOST || 'smtp.gmail.com'}, port=${port}, secure=${secure}, user=${process.env.EMAIL_USER || '(no configurado)'}`);

    return nodemailer.createTransport({
        host: process.env.EMAIL_HOST || 'smtp.gmail.com',
        port,
        secure,
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASSWORD
        }
    });
};

/**
 * Enviar email genérico
 */
async function sendEmail({ to, subject, html, text = null }) {
    try {
        // Verificar que las credenciales estén configuradas
        if (!process.env.EMAIL_USER || !process.env.EMAIL_PASSWORD) {
            console.error('❌ EMAIL_USER o EMAIL_PASSWORD no están configurados');
            return false;
        }

        const transporter = createTransporter();

        const info = await transporter.sendMail({
            from: process.env.EMAIL_FROM || '"SYA Tortillerías" <noreply@syatortillerias.com>',
            to,
            subject,
            text,
            html
        });

        console.log(`✅ Email enviado a ${to}: messageId=${info.messageId}`);
        return true;
    } catch (err) {
        console.error(`❌ Error enviando email a ${to}:`, err.message);
        console.error(`❌ SMTP config: host=${process.env.EMAIL_HOST}, port=${process.env.EMAIL_PORT}, user=${process.env.EMAIL_USER}`);
        return false;
    }
}

/**
 * Email de recuperación de contraseña
 */
async function sendPasswordResetEmail({ to, recipientName, temporaryPassword, isForAdmin = false, employeeName = null }) {
    const subject = isForAdmin
        ? `Recuperación de Contraseña - ${employeeName}`
        : 'Recuperación de Contraseña - SYA Tortillerías';

    const greeting = isForAdmin
        ? `Hola, ${recipientName}. El empleado <strong>${employeeName}</strong> ha solicitado recuperar su contraseña.`
        : `Hola, ${recipientName}. Has solicitado recuperar tu contraseña.`;

    const html = `
        <!DOCTYPE html>
        <html>
        <head>
            <style>
                body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
                .container { max-width: 600px; margin: 0 auto; padding: 20px; }
                .header { background: #4CAF50; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
                .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px; }
                .password-box { background: white; padding: 20px; border-left: 4px solid #FF9800; margin: 20px 0; text-align: center; border-radius: 4px; }
                .password { font-size: 32px; font-weight: bold; letter-spacing: 4px; color: #FF9800; font-family: monospace; }
                .footer { text-align: center; margin-top: 30px; color: #666; font-size: 12px; }
                .warning { color: #f44336; font-size: 14px; margin-top: 20px; background: #ffebee; padding: 10px; border-radius: 4px; }
                ol { margin-left: 20px; }
                ol li { margin-bottom: 8px; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1 style="margin: 0;">Recuperación de Contraseña</h1>
                </div>
                <div class="content">
                    <p>${greeting}</p>

                    <div class="password-box">
                        <p style="margin-bottom: 10px; color: #666;">Tu contraseña temporal es:</p>
                        <p class="password">${temporaryPassword}</p>
                    </div>

                    <h3>Instrucciones:</h3>
                    <ol>
                        <li>Abre la aplicación SYA Tortillerías</li>
                        <li>Inicia sesión con tu usuario y la contraseña temporal</li>
                        <li>Se te pedirá crear una nueva contraseña</li>
                    </ol>

                    <p class="warning">⚠️ Esta contraseña temporal es de un solo uso. Deberás cambiarla al iniciar sesión.</p>

                    ${isForAdmin ? `<p><strong>Nota:</strong> Por favor, comunica esta contraseña temporal a ${employeeName} de forma segura.</p>` : ''}

                    <p style="margin-top: 20px; color: #666;">Si no solicitaste este cambio, ignora este mensaje y contacta al administrador.</p>
                </div>

                <div class="footer">
                    <p>SYA Tortillerías | Sistema de Gestión para Tortillerías</p>
                    <p>Este email fue enviado a ${to}</p>
                </div>
            </div>
        </body>
        </html>
    `;

    return await sendEmail({ to, subject, html });
}

/**
 * Email de verificación para acceso móvil
 */
async function sendVerificationEmail({ to, recipientName, code }) {
    const subject = 'Código de Verificación - SYA Tortillerías';

    const html = `
        <!DOCTYPE html>
        <html>
        <head>
            <style>
                body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
                .container { max-width: 600px; margin: 0 auto; padding: 20px; }
                .header { background: #2196F3; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
                .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px; }
                .code-box { background: white; padding: 20px; border-left: 4px solid #2196F3; margin: 20px 0; text-align: center; border-radius: 4px; }
                .code { font-size: 36px; font-weight: bold; letter-spacing: 8px; color: #2196F3; font-family: monospace; }
                .footer { text-align: center; margin-top: 30px; color: #666; font-size: 12px; }
                .warning { color: #f44336; font-size: 14px; margin-top: 20px; background: #ffebee; padding: 10px; border-radius: 4px; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1 style="margin: 0;">Verificación de Email</h1>
                </div>
                <div class="content">
                    <p>Hola, <strong>${recipientName}</strong>.</p>
                    <p>Se ha registrado tu correo electrónico para acceder a la aplicación móvil de SYA Tortillerías.</p>

                    <div class="code-box">
                        <p style="margin-bottom: 10px; color: #666;">Tu código de verificación es:</p>
                        <p class="code">${code}</p>
                    </div>

                    <p>Ingresa este código en la aplicación para verificar tu email y activar tu acceso móvil.</p>

                    <p class="warning">⚠️ Este código expira en 24 horas. Si no solicitaste este registro, ignora este mensaje.</p>
                </div>

                <div class="footer">
                    <p>SYA Tortillerías | Sistema de Gestión para Tortillerías</p>
                    <p>Este email fue enviado a ${to}</p>
                </div>
            </div>
        </body>
        </html>
    `;

    return await sendEmail({ to, subject, html });
}

module.exports = {
    sendEmail,
    sendPasswordResetEmail,
    sendVerificationEmail
};
