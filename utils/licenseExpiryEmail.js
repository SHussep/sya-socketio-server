// ═══════════════════════════════════════════════════════════
// LICENSE EXPIRY EMAIL - Aviso de vencimiento de licencia/trial
// Se envía solo al owner del tenant
// ═══════════════════════════════════════════════════════════

const { sendEmail } = require('./emailService');

/**
 * Envía email de aviso de vencimiento de licencia.
 * @param {object} params
 * @param {string} params.to - Email del owner
 * @param {string} params.ownerName - Nombre del owner
 * @param {string} params.businessName - Nombre del negocio
 * @param {number} params.daysRemaining - Días restantes (puede ser negativo si ya venció)
 * @param {string} params.expiryDate - Fecha formateada de vencimiento
 * @param {boolean} params.isTrial - true si es trial, false si es suscripción
 */
async function sendLicenseExpiryEmail({ to, ownerName, businessName, daysRemaining, expiryDate, isTrial }) {
    const planType = isTrial ? 'período de prueba' : 'suscripción';

    let subject, urgencyColor, urgencyIcon, urgencyMessage;

    if (daysRemaining <= 0) {
        subject = `⚠️ Tu ${planType} ha vencido - ${businessName}`;
        urgencyColor = '#DC2626';
        urgencyIcon = '🔴';
        urgencyMessage = `Tu ${planType} venció el ${expiryDate}. El acceso al sistema será limitado hasta que renueves.`;
    } else if (daysRemaining <= 3) {
        subject = `⚠️ Tu ${planType} vence en ${daysRemaining} día(s) - ${businessName}`;
        urgencyColor = '#DC2626';
        urgencyIcon = '🔴';
        urgencyMessage = `Tu ${planType} vence en ${daysRemaining} día(s) (${expiryDate}). Renueva ahora para evitar interrupciones.`;
    } else if (daysRemaining <= 7) {
        subject = `Tu ${planType} vence pronto - ${businessName}`;
        urgencyColor = '#F59E0B';
        urgencyIcon = '🟠';
        urgencyMessage = `Tu ${planType} vence el ${expiryDate} (en ${daysRemaining} días). Te recomendamos renovar con anticipación.`;
    } else {
        subject = `Recordatorio: Tu ${planType} vence el ${expiryDate} - ${businessName}`;
        urgencyColor = '#3B82F6';
        urgencyIcon = 'ℹ️';
        urgencyMessage = `Tu ${planType} vence el ${expiryDate} (en ${daysRemaining} días).`;
    }

    const html = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <style>
                body { font-family: -apple-system, Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background: #f5f5f5; }
                .container { max-width: 600px; margin: 0 auto; padding: 20px; }
                .header { background: #19376D; color: white; padding: 24px 30px; border-radius: 8px 8px 0 0; }
                .header h1 { margin: 0 0 4px 0; font-size: 20px; font-weight: 600; }
                .header p { margin: 0; font-size: 13px; opacity: 0.85; }
                .content { background: white; padding: 30px; border-radius: 0 0 8px 8px; }
                .status-bar { padding: 14px 18px; border-radius: 6px; margin-bottom: 24px; font-size: 14px; }
                .info-box { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 6px; padding: 18px; margin: 20px 0; }
                .info-row { display: flex; justify-content: space-between; padding: 6px 0; font-size: 14px; }
                .info-label { color: #6b7280; }
                .info-value { font-weight: 600; color: #111827; }
                .footer { text-align: center; margin-top: 24px; color: #9ca3af; font-size: 12px; line-height: 1.8; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1>${daysRemaining <= 0 ? 'Licencia Vencida' : 'Aviso de Vencimiento'}</h1>
                    <p>${businessName}</p>
                </div>
                <div class="content">
                    <p style="margin-top:0;">Hola, <strong>${ownerName}</strong>.</p>

                    <div class="status-bar" style="background:${urgencyColor}15;border-left:4px solid ${urgencyColor};">
                        ${urgencyIcon} ${urgencyMessage}
                    </div>

                    <div class="info-box">
                        <table width="100%" cellspacing="0" cellpadding="0" style="font-size:14px;">
                            <tr>
                                <td style="padding:6px 0;color:#6b7280;">Tipo de plan:</td>
                                <td style="padding:6px 0;font-weight:600;text-align:right;">${isTrial ? 'Período de Prueba' : 'Suscripción Activa'}</td>
                            </tr>
                            <tr>
                                <td style="padding:6px 0;color:#6b7280;">Fecha de vencimiento:</td>
                                <td style="padding:6px 0;font-weight:600;text-align:right;">${expiryDate}</td>
                            </tr>
                            <tr>
                                <td style="padding:6px 0;color:#6b7280;">Estado:</td>
                                <td style="padding:6px 0;font-weight:600;text-align:right;color:${urgencyColor};">
                                    ${daysRemaining <= 0 ? 'Vencido' : `${daysRemaining} día(s) restantes`}
                                </td>
                            </tr>
                        </table>
                    </div>

                    <p style="font-size:14px;color:#374151;">
                        ${daysRemaining <= 0
                            ? 'Para reactivar tu acceso completo al sistema, por favor contacta a soporte o renueva tu plan desde la aplicación.'
                            : 'Para renovar o actualizar tu plan, contacta a soporte o hazlo directamente desde la aplicación.'}
                    </p>

                    <p style="font-size:14px;color:#374151;">
                        Si tienes dudas, responde a este correo o contáctanos directamente.
                    </p>
                </div>

                <div class="footer">
                    <p>SYA Tortillerías | Sistema de Gestión para Tortillerías</p>
                    <p>Este correo fue enviado a ${to}</p>
                </div>
            </div>
        </body>
        </html>
    `;

    return await sendEmail({ to, subject, html });
}

module.exports = { sendLicenseExpiryEmail };
