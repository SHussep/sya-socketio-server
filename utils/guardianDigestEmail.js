// ═══════════════════════════════════════════════════════════
// GUARDIAN DIGEST EMAIL - Resumen periódico de eventos
// Se envía solo al owner del tenant
// ═══════════════════════════════════════════════════════════

const { sendEmail } = require('./emailService');

/**
 * Envía el email de resumen Guardian al owner del tenant.
 */
async function sendGuardianDigestEmail({
    to,
    ownerName,
    businessName,
    frequency,
    periodLabel,
    branches,
    totals
}) {
    const subject = `Resumen Guardian - ${businessName} (${periodLabel})`;

    // Generar filas de sucursales
    const branchRows = branches.map(b => `
        <tr>
            <td style="padding:10px 12px;border-bottom:1px solid #eee;font-size:14px;">${b.branchName}</td>
            <td style="padding:10px 12px;border-bottom:1px solid #eee;text-align:center;font-size:14px;">${b.totalEvents}</td>
            <td style="padding:10px 12px;border-bottom:1px solid #eee;text-align:center;font-size:14px;color:${b.critical > 0 ? '#DC2626' : '#666'};">${b.critical}</td>
            <td style="padding:10px 12px;border-bottom:1px solid #eee;text-align:center;font-size:14px;color:${b.high > 0 ? '#F59E0B' : '#666'};">${b.high}</td>
            <td style="padding:10px 12px;border-bottom:1px solid #eee;text-align:center;font-size:14px;">${b.disconnections}</td>
        </tr>
    `).join('');

    // Determinar color y mensaje del resumen
    let statusColor, statusIcon, statusMessage;
    if (totals.critical > 0) {
        statusColor = '#DC2626';
        statusIcon = '🔴';
        statusMessage = `${totals.critical} evento(s) crítico(s) detectado(s). Se recomienda revisar la actividad.`;
    } else if (totals.high > 0) {
        statusColor = '#F59E0B';
        statusIcon = '🟠';
        statusMessage = `${totals.high} evento(s) de alta severidad. Revisa los detalles en la app.`;
    } else if (totals.totalEvents > 0) {
        statusColor = '#3B82F6';
        statusIcon = 'ℹ️';
        statusMessage = `${totals.totalEvents} evento(s) registrado(s). Sin alertas críticas.`;
    } else {
        statusColor = '#22C55E';
        statusIcon = '✅';
        statusMessage = 'Sin eventos sospechosos en este período. Todo en orden.';
    }

    // Instrucciones para desactivar según frecuencia
    const freqLabel = frequency === 'weekly' ? 'semanal'
        : frequency === 'biweekly' ? 'quincenal'
        : 'mensual';

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
                .summary-grid { display: flex; gap: 12px; margin-bottom: 24px; }
                .metric-card { flex: 1; background: #f9fafb; border-radius: 6px; padding: 14px; text-align: center; border: 1px solid #e5e7eb; }
                .metric-value { font-size: 28px; font-weight: 700; margin-bottom: 2px; }
                .metric-label { font-size: 11px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px; }
                table { width: 100%; border-collapse: collapse; margin-bottom: 24px; }
                th { background: #19376D; color: white; padding: 10px 12px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; text-align: left; }
                th:not(:first-child) { text-align: center; }
                .footer { text-align: center; margin-top: 24px; color: #9ca3af; font-size: 12px; line-height: 1.8; }
                .opt-out { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 6px; padding: 16px; margin-top: 24px; font-size: 13px; color: #6b7280; }
                .opt-out strong { color: #374151; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1>Resumen Guardian</h1>
                    <p>${businessName} &mdash; ${periodLabel}</p>
                </div>
                <div class="content">
                    <p style="margin-top:0;">Hola, <strong>${ownerName}</strong>.</p>
                    <p>Este es tu resumen ${freqLabel} de actividad del sistema Guardian de seguridad.</p>

                    <div class="status-bar" style="background:${statusColor}15;border-left:4px solid ${statusColor};">
                        ${statusIcon} ${statusMessage}
                    </div>

                    <!--[if mso]>
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>
                    <![endif]-->
                    <div class="summary-grid">
                        <div class="metric-card">
                            <div class="metric-value" style="color:${totals.totalEvents > 0 ? '#19376D' : '#22C55E'};">${totals.totalEvents}</div>
                            <div class="metric-label">Total Eventos</div>
                        </div>
                        <div class="metric-card">
                            <div class="metric-value" style="color:${totals.critical > 0 ? '#DC2626' : '#666'};">${totals.critical}</div>
                            <div class="metric-label">Críticos</div>
                        </div>
                        <div class="metric-card">
                            <div class="metric-value" style="color:${totals.high > 0 ? '#F59E0B' : '#666'};">${totals.high}</div>
                            <div class="metric-label">Alta Severidad</div>
                        </div>
                        <div class="metric-card">
                            <div class="metric-value" style="color:#666;">${totals.disconnections}</div>
                            <div class="metric-label">Desconexiones</div>
                        </div>
                    </div>
                    <!--[if mso]>
                    </tr></table>
                    <![endif]-->

                    ${branches.length > 1 ? `
                    <h3 style="font-size:14px;color:#19376D;margin-bottom:8px;">Desglose por Sucursal</h3>
                    <table>
                        <thead>
                            <tr>
                                <th>Sucursal</th>
                                <th>Total</th>
                                <th>Críticos</th>
                                <th>Altos</th>
                                <th>Desconexiones</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${branchRows}
                        </tbody>
                    </table>
                    ` : ''}

                    <p style="font-size:14px;color:#374151;">
                        Para ver el detalle completo, abre la aplicación SYA Tortillerías y navega a
                        <strong>Más &gt; Guardian</strong> o genera un reporte PDF desde la sección de eventos.
                    </p>

                    <div class="opt-out">
                        <strong>¿No deseas recibir estos correos?</strong><br>
                        Puedes desactivarlos o cambiar la frecuencia desde la aplicación móvil:<br>
                        <strong>Más &gt; Configuración &gt; Notificaciones &gt; Resumen Guardian por Email</strong><br>
                        <span style="font-size:12px;">Frecuencia actual: ${freqLabel}</span>
                    </div>
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

module.exports = { sendGuardianDigestEmail };
