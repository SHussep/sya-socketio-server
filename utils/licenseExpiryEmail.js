// ═══════════════════════════════════════════════════════════
// LICENSE EXPIRY EMAIL - Aviso de vencimiento de licencia/trial
// Se envía solo al owner del tenant
// ═══════════════════════════════════════════════════════════

const { sendEmail } = require('./emailService');

const WHATSAPP_NUMBER = '5540538426';
const WHATSAPP_LINK = `https://wa.me/52${WHATSAPP_NUMBER}`;

/**
 * Envía email de aviso de vencimiento de licencia.
 */
async function sendLicenseExpiryEmail({ to, ownerName, businessName, daysRemaining, expiryDate, isTrial }) {
    const planType = isTrial ? 'período de prueba' : 'suscripción';
    const planTypeShort = isTrial ? 'prueba' : 'suscripción';

    let subject, urgencyColor, urgencyIcon, urgencyMessage, ctaText;

    if (daysRemaining <= 0) {
        subject = `⚠️ ${businessName} — Tu ${planTypeShort} ha vencido`;
        urgencyColor = '#DC2626';
        urgencyIcon = '🔴';
        urgencyMessage = `Tu ${planType} venció el <strong>${expiryDate}</strong>. Algunas funciones del sistema serán limitadas hasta que renueves tu plan.`;
        ctaText = 'Renueva ahora para restaurar el acceso completo';
    } else if (daysRemaining <= 3) {
        subject = `⚠️ ${businessName} — Tu ${planTypeShort} vence en ${daysRemaining} día(s)`;
        urgencyColor = '#DC2626';
        urgencyIcon = '🔴';
        urgencyMessage = `Tu ${planType} vence el <strong>${expiryDate}</strong> (en ${daysRemaining} día${daysRemaining > 1 ? 's' : ''}). Renueva ahora para evitar interrupciones en tu operación.`;
        ctaText = 'Renueva antes de que expire';
    } else if (daysRemaining <= 7) {
        subject = `${businessName} — Tu ${planTypeShort} vence en ${daysRemaining} días`;
        urgencyColor = '#F59E0B';
        urgencyIcon = '🟠';
        urgencyMessage = `Tu ${planType} vence el <strong>${expiryDate}</strong> (en ${daysRemaining} días). Te recomendamos renovar con anticipación para no perder acceso.`;
        ctaText = 'Renueva con anticipación';
    } else {
        subject = `${businessName} — Recordatorio de vencimiento (${expiryDate})`;
        urgencyColor = '#3B82F6';
        urgencyIcon = 'ℹ️';
        urgencyMessage = `Tu ${planType} está vigente hasta el <strong>${expiryDate}</strong> (${daysRemaining} días restantes).`;
        ctaText = 'Consulta opciones de renovación';
    }

    // Qué incluye el plan
    const benefitsList = isTrial ? `
        <div style="font-size:13px;color:#374151;line-height:1.7;">
            <strong>Tu período de prueba incluye:</strong><br>
            ✓ Sistema de punto de venta completo<br>
            ✓ Guardian de báscula (detección de fraudes)<br>
            ✓ Reportes y auditorías de seguridad<br>
            ✓ Sincronización con app móvil<br>
            ✓ Soporte técnico por WhatsApp
        </div>
    ` : `
        <div style="font-size:13px;color:#374151;line-height:1.7;">
            <strong>Tu suscripción incluye:</strong><br>
            ✓ Todas las funciones del sistema SYA<br>
            ✓ Actualizaciones automáticas<br>
            ✓ Soporte técnico prioritario<br>
            ✓ Respaldos en la nube
        </div>
    `;

    // Qué pasa si no renueva
    let consequenceHtml = '';
    if (daysRemaining <= 7) {
        consequenceHtml = `
            <div style="background:#FEF2F2;border:1px solid #FECACA;border-radius:8px;padding:14px;margin:16px 0;font-size:13px;color:#991B1B;line-height:1.6;">
                <strong>¿Qué pasa si no renuevo?</strong><br>
                ${daysRemaining <= 0
                    ? 'Tu sistema está funcionando con acceso limitado. Los datos se conservan pero algunas funciones estarán restringidas hasta que renueves.'
                    : 'Si tu plan vence, el sistema seguirá funcionando con acceso limitado. No perderás tus datos, pero algunas funciones se restringirán.'}
            </div>
        `;
    }

    const html = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <style>
                body { font-family: -apple-system, Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background: #f5f5f5; }
                .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            </style>
        </head>
        <body>
            <div class="container">
                <!-- HEADER -->
                <div style="background:linear-gradient(135deg, #19376D 0%, #0B2447 100%);color:white;padding:28px 30px;border-radius:10px 10px 0 0;">
                    <div style="font-size:22px;font-weight:700;margin:0 0 2px 0;">
                        ${daysRemaining <= 0 ? 'Tu Plan Ha Vencido' : 'Aviso de Vencimiento'}
                    </div>
                    <div style="font-size:14px;opacity:0.9;">${businessName}</div>
                    <div style="font-size:12px;opacity:0.7;margin-top:6px;">SYA Tortillerías — Sistema de Gestión</div>
                </div>

                <!-- CONTENT -->
                <div style="background:white;padding:30px;border-radius:0 0 10px 10px;border:1px solid #e5e7eb;border-top:none;">
                    <p style="margin-top:0;font-size:15px;">Hola, <strong>${ownerName}</strong>.</p>

                    <!-- Status bar -->
                    <div style="padding:14px 18px;border-radius:8px;margin-bottom:20px;font-size:14px;line-height:1.5;background:${urgencyColor}12;border-left:4px solid ${urgencyColor};">
                        ${urgencyIcon} ${urgencyMessage}
                    </div>

                    <!-- Plan info card -->
                    <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:18px;margin:20px 0;">
                        <table width="100%" cellspacing="0" cellpadding="0" style="font-size:14px;">
                            <tr>
                                <td style="padding:8px 0;color:#6b7280;">Negocio:</td>
                                <td style="padding:8px 0;font-weight:600;text-align:right;color:#111827;">${businessName}</td>
                            </tr>
                            <tr>
                                <td style="padding:8px 0;color:#6b7280;">Tipo de plan:</td>
                                <td style="padding:8px 0;font-weight:600;text-align:right;color:#111827;">${isTrial ? 'Período de Prueba' : 'Suscripción Activa'}</td>
                            </tr>
                            <tr>
                                <td style="padding:8px 0;color:#6b7280;">Fecha de vencimiento:</td>
                                <td style="padding:8px 0;font-weight:700;text-align:right;color:#111827;">${expiryDate}</td>
                            </tr>
                            <tr>
                                <td style="padding:8px 0;color:#6b7280;">Estado:</td>
                                <td style="padding:8px 0;font-weight:700;text-align:right;color:${urgencyColor};">
                                    ${daysRemaining <= 0 ? 'Vencido' : `${daysRemaining} día${daysRemaining > 1 ? 's' : ''} restante${daysRemaining > 1 ? 's' : ''}`}
                                </td>
                            </tr>
                        </table>
                    </div>

                    ${consequenceHtml}

                    ${daysRemaining > 7 ? benefitsList : ''}

                    <!-- CTA: WhatsApp -->
                    <div style="text-align:center;margin:28px 0 20px 0;">
                        <div style="font-size:14px;color:#374151;margin-bottom:12px;">${ctaText}</div>
                        <table cellspacing="0" cellpadding="0" style="margin:0 auto;">
                            <tr>
                                <td style="background:#25D366;border-radius:8px;padding:0;">
                                    <a href="${WHATSAPP_LINK}" target="_blank" style="display:inline-block;padding:14px 28px;color:white;text-decoration:none;font-size:15px;font-weight:600;">
                                        <!-- WhatsApp icon (inline) -->
                                        <span style="font-size:18px;vertical-align:middle;margin-right:8px;">💬</span>
                                        Escríbenos por WhatsApp
                                    </a>
                                </td>
                            </tr>
                        </table>
                        <div style="font-size:13px;color:#6b7280;margin-top:10px;">
                            O llámanos al <strong>${WHATSAPP_NUMBER.replace(/(\d{3})(\d{3})(\d{4})/, '$1 $2 $3')}</strong>
                        </div>
                    </div>

                    <!-- Divider -->
                    <div style="border-top:1px solid #e5e7eb;margin:24px 0;"></div>

                    <!-- Secondary info -->
                    <div style="font-size:13px;color:#6b7280;line-height:1.6;">
                        <strong>¿Cómo renovar?</strong><br>
                        Comunícate con nuestro equipo por WhatsApp o teléfono y te guiaremos en el proceso de renovación.
                        Tu información y datos están seguros — al renovar, todo seguirá exactamente como lo dejaste.
                    </div>
                </div>

                <!-- FOOTER -->
                <div style="text-align:center;margin-top:20px;color:#9ca3af;font-size:12px;line-height:1.8;">
                    <p><strong>SYA Tortillerías</strong> — Sistema de Gestión para Tortillerías</p>
                    <p style="font-size:11px;">
                        Este correo es generado automáticamente. Para dejar de recibir estos avisos,
                        contacta a soporte.
                    </p>
                </div>
            </div>
        </body>
        </html>
    `;

    return await sendEmail({ to, subject, html });
}

module.exports = { sendLicenseExpiryEmail };
