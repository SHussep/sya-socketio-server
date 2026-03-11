// ═══════════════════════════════════════════════════════════
// GUARDIAN DIGEST EMAIL - Resumen periódico de eventos
// Se envía solo al owner del tenant
// ═══════════════════════════════════════════════════════════

const { sendEmail } = require('./emailService');

// Mapeo de fraud_type a etiquetas legibles
const FRAUD_TYPE_LABELS = {
    'FRD-001': 'Peso no registrado en báscula',
    'FRD-002': 'Operación irregular detectada',
    'FRD-003': 'Discrepancia de peso',
    'FRD-004': 'Peso retirado post-registro',
    'FRD-005': 'Peso añadido post-registro',
    'FRD-006': 'Pesaje fraccionado sospechoso',
    'FRD-007': 'Peso no registrado (cobro)',
    'FRD-008': 'Pesaje cancelado',
    'FRD-009': 'Producto eliminado después de pesar',
    'FRD-010': 'TARA sospechosa'
};

/**
 * Envía el email de resumen Guardian al owner del tenant.
 * @param {object} params
 * @param {string} params.to
 * @param {string} params.ownerName
 * @param {string} params.businessName
 * @param {string} params.frequency - weekly|biweekly|monthly
 * @param {string} params.periodLabel - "01/03/2026 - 11/03/2026"
 * @param {Array} params.branches - [{branchName, totalEvents, critical, high, disconnections}]
 * @param {object} params.totals - {totalEvents, critical, high, disconnections}
 * @param {Array} [params.topEventTypes] - [{fraud_type, label, count}] top 5
 * @param {Array} [params.recentCritical] - [{description, severity, timestamp, branchName, employeeName}] top 3
 * @param {number} [params.daysInPeriod] - días en el período
 */
async function sendGuardianDigestEmail({
    to,
    ownerName,
    businessName,
    frequency,
    periodLabel,
    branches,
    totals,
    topEventTypes = [],
    recentCritical = [],
    daysInPeriod = 14
}) {
    // Subject más claro y con contexto
    let subjectPrefix = '';
    if (totals.critical > 5) subjectPrefix = '⚠️ ';
    else if (totals.critical > 0) subjectPrefix = '🔶 ';

    const subject = `${subjectPrefix}${businessName} — ${totals.totalEvents} eventos detectados (${periodLabel})`;

    // Generar filas de sucursales
    const branchRows = branches.map(b => `
        <tr>
            <td style="padding:10px 12px;border-bottom:1px solid #eee;font-size:14px;font-weight:500;">${b.branchName}</td>
            <td style="padding:10px 12px;border-bottom:1px solid #eee;text-align:center;font-size:14px;font-weight:600;">${b.totalEvents}</td>
            <td style="padding:10px 12px;border-bottom:1px solid #eee;text-align:center;font-size:14px;color:${b.critical > 0 ? '#DC2626' : '#9ca3af'};font-weight:${b.critical > 0 ? '700' : '400'};">${b.critical}</td>
            <td style="padding:10px 12px;border-bottom:1px solid #eee;text-align:center;font-size:14px;color:${b.high > 0 ? '#F59E0B' : '#9ca3af'};font-weight:${b.high > 0 ? '600' : '400'};">${b.high}</td>
            <td style="padding:10px 12px;border-bottom:1px solid #eee;text-align:center;font-size:14px;">${b.disconnections}</td>
        </tr>
    `).join('');

    // Determinar nivel de alerta y mensaje contextual
    let statusColor, statusIcon, statusMessage;
    const avgPerDay = daysInPeriod > 0 ? (totals.totalEvents / daysInPeriod).toFixed(1) : 0;

    if (totals.critical > 5) {
        statusColor = '#DC2626';
        statusIcon = '🔴';
        statusMessage = `Se detectaron <strong>${totals.critical} eventos críticos</strong> en este período. Esto puede indicar intentos de manipulación de la báscula. Te recomendamos revisar los detalles lo antes posible.`;
    } else if (totals.critical > 0) {
        statusColor = '#F59E0B';
        statusIcon = '🟠';
        statusMessage = `Se detectaron <strong>${totals.critical} evento(s) crítico(s)</strong>. Revisa los detalles para determinar si requieren atención.`;
    } else if (totals.totalEvents > 50) {
        statusColor = '#3B82F6';
        statusIcon = 'ℹ️';
        statusMessage = `Se registraron ${totals.totalEvents} eventos (promedio ${avgPerDay}/día). Aunque no hay eventos críticos, el volumen sugiere revisar la configuración de sensibilidad.`;
    } else if (totals.totalEvents > 0) {
        statusColor = '#3B82F6';
        statusIcon = 'ℹ️';
        statusMessage = `Se registraron ${totals.totalEvents} evento(s) sin alertas críticas. Actividad dentro de lo normal.`;
    } else {
        statusColor = '#22C55E';
        statusIcon = '✅';
        statusMessage = 'No se detectaron eventos sospechosos en este período. Tu báscula operó sin irregularidades.';
    }

    // Frecuencia label
    const freqLabel = frequency === 'weekly' ? 'semanal'
        : frequency === 'biweekly' ? 'quincenal'
        : 'mensual';

    // Generar sección de tipos de eventos más frecuentes
    let topEventsHtml = '';
    if (topEventTypes.length > 0) {
        const rows = topEventTypes.slice(0, 5).map((evt, i) => {
            const pct = totals.totalEvents > 0 ? Math.round(evt.count / totals.totalEvents * 100) : 0;
            const barWidth = Math.max(pct, 3);
            return `
                <tr>
                    <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;font-size:13px;">
                        <span style="color:#6b7280;font-weight:500;">${evt.fraud_type}</span><br>
                        <span style="color:#374151;">${evt.label}</span>
                    </td>
                    <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;text-align:center;font-size:14px;font-weight:600;">${evt.count}</td>
                    <td style="padding:8px 12px;border-bottom:1px solid #f3f4f6;width:120px;">
                        <div style="background:#e5e7eb;border-radius:4px;height:8px;overflow:hidden;">
                            <div style="background:#19376D;height:8px;width:${barWidth}%;border-radius:4px;"></div>
                        </div>
                        <span style="font-size:11px;color:#9ca3af;">${pct}%</span>
                    </td>
                </tr>
            `;
        }).join('');

        topEventsHtml = `
            <h3 style="font-size:15px;color:#19376D;margin:24px 0 10px 0;font-weight:600;">Tipos de Eventos Más Frecuentes</h3>
            <table width="100%" cellspacing="0" cellpadding="0" style="border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
                <thead>
                    <tr style="background:#f9fafb;">
                        <th style="padding:10px 12px;font-size:12px;text-align:left;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Tipo</th>
                        <th style="padding:10px 12px;font-size:12px;text-align:center;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Cantidad</th>
                        <th style="padding:10px 12px;font-size:12px;text-align:left;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Proporción</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        `;
    }

    // Generar sección de eventos críticos recientes
    let criticalEventsHtml = '';
    if (recentCritical.length > 0) {
        const items = recentCritical.slice(0, 3).map(evt => `
            <div style="padding:12px 14px;border-left:3px solid ${evt.severity === 'Critical' ? '#DC2626' : '#F59E0B'};background:${evt.severity === 'Critical' ? '#FEF2F2' : '#FFFBEB'};border-radius:0 6px 6px 0;margin-bottom:8px;">
                <div style="font-size:13px;font-weight:600;color:${evt.severity === 'Critical' ? '#991B1B' : '#92400E'};">
                    ${evt.severity === 'Critical' ? '🔴' : '🟠'} ${evt.description}
                </div>
                <div style="font-size:12px;color:#6b7280;margin-top:4px;">
                    ${evt.branchName}${evt.employeeName ? ` · ${evt.employeeName}` : ''} · ${evt.timestamp}
                </div>
            </div>
        `).join('');

        criticalEventsHtml = `
            <h3 style="font-size:15px;color:#DC2626;margin:24px 0 10px 0;font-weight:600;">Eventos que Requieren Atención</h3>
            ${items}
        `;
    }

    // Insights automáticos
    let insightsHtml = '';
    const insights = [];
    if (totals.disconnections > 3) {
        insights.push(`Se registraron <strong>${totals.disconnections} desconexiones</strong> de báscula. Si son frecuentes, verifica el cable USB y la conexión eléctrica.`);
    }
    if (avgPerDay > 20) {
        insights.push(`El promedio de <strong>${avgPerDay} eventos por día</strong> es alto. Considera ajustar la sensibilidad del Guardian desde Configuración para reducir falsos positivos.`);
    }
    if (branches.length > 1) {
        const worst = branches.reduce((a, b) => a.totalEvents > b.totalEvents ? a : b);
        if (worst.totalEvents > 0) {
            insights.push(`La sucursal con más actividad es <strong>${worst.branchName}</strong> con ${worst.totalEvents} eventos.`);
        }
    }
    if (insights.length > 0) {
        insightsHtml = `
            <div style="background:#EFF6FF;border:1px solid #BFDBFE;border-radius:8px;padding:16px;margin:20px 0;">
                <div style="font-size:14px;font-weight:600;color:#1E40AF;margin-bottom:8px;">💡 Observaciones</div>
                ${insights.map(i => `<div style="font-size:13px;color:#1E3A5F;margin-bottom:6px;">• ${i}</div>`).join('')}
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
                .container { max-width: 640px; margin: 0 auto; padding: 20px; }
                .header { background: linear-gradient(135deg, #19376D 0%, #0B2447 100%); color: white; padding: 28px 30px; border-radius: 10px 10px 0 0; }
                .header h1 { margin: 0 0 2px 0; font-size: 22px; font-weight: 700; }
                .header .subtitle { margin: 0; font-size: 14px; opacity: 0.9; }
                .header .brand { font-size: 12px; opacity: 0.7; margin-top: 8px; }
                .content { background: white; padding: 30px; border-radius: 0 0 10px 10px; border: 1px solid #e5e7eb; border-top: none; }
                .status-bar { padding: 14px 18px; border-radius: 8px; margin-bottom: 24px; font-size: 14px; line-height: 1.5; }
                table { width: 100%; border-collapse: collapse; }
                .footer { text-align: center; margin-top: 20px; color: #9ca3af; font-size: 12px; line-height: 1.8; }
                .opt-out { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; margin-top: 24px; font-size: 13px; color: #6b7280; line-height: 1.6; }
                .opt-out strong { color: #374151; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1>Reporte de Seguridad Guardian</h1>
                    <p class="subtitle">${businessName} · ${periodLabel}</p>
                    <p class="brand">SYA Tortillerías — Monitoreo de Báscula</p>
                </div>
                <div class="content">
                    <p style="margin-top:0;font-size:15px;">Hola, <strong>${ownerName}</strong>.</p>
                    <p style="font-size:14px;color:#4B5563;">
                        Este es el reporte ${freqLabel} del <strong>sistema Guardian</strong>, que monitorea tu(s) báscula(s)
                        para detectar operaciones irregulares, manipulaciones de peso y desconexiones.
                        ${totals.totalEvents > 0
                            ? `Durante este período se registraron <strong>${totals.totalEvents} evento(s)</strong> en ${branches.length} sucursal(es).`
                            : 'No se detectó actividad sospechosa en este período.'}
                    </p>

                    <div class="status-bar" style="background:${statusColor}12;border-left:4px solid ${statusColor};">
                        ${statusIcon} ${statusMessage}
                    </div>

                    <!-- KPI Cards usando tabla para compatibilidad email -->
                    <table cellspacing="0" cellpadding="0" style="margin-bottom:24px;">
                        <tr>
                            <td style="padding:4px;">
                                <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:16px;text-align:center;">
                                    <div style="font-size:30px;font-weight:700;color:${totals.totalEvents > 0 ? '#19376D' : '#22C55E'};">${totals.totalEvents}</div>
                                    <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;margin-top:2px;">Total Eventos</div>
                                </div>
                            </td>
                            <td style="padding:4px;">
                                <div style="background:${totals.critical > 0 ? '#FEF2F2' : '#f9fafb'};border:1px solid ${totals.critical > 0 ? '#FECACA' : '#e5e7eb'};border-radius:8px;padding:16px;text-align:center;">
                                    <div style="font-size:30px;font-weight:700;color:${totals.critical > 0 ? '#DC2626' : '#9ca3af'};">${totals.critical}</div>
                                    <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;margin-top:2px;">Críticos</div>
                                </div>
                            </td>
                            <td style="padding:4px;">
                                <div style="background:${totals.high > 0 ? '#FFFBEB' : '#f9fafb'};border:1px solid ${totals.high > 0 ? '#FDE68A' : '#e5e7eb'};border-radius:8px;padding:16px;text-align:center;">
                                    <div style="font-size:30px;font-weight:700;color:${totals.high > 0 ? '#F59E0B' : '#9ca3af'};">${totals.high}</div>
                                    <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;margin-top:2px;">Alta Severidad</div>
                                </div>
                            </td>
                            <td style="padding:4px;">
                                <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:16px;text-align:center;">
                                    <div style="font-size:30px;font-weight:700;color:${totals.disconnections > 0 ? '#7C3AED' : '#9ca3af'};">${totals.disconnections}</div>
                                    <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;margin-top:2px;">Desconexiones</div>
                                </div>
                            </td>
                        </tr>
                    </table>

                    ${criticalEventsHtml}

                    ${topEventsHtml}

                    ${branches.length > 1 ? `
                    <h3 style="font-size:15px;color:#19376D;margin:24px 0 10px 0;font-weight:600;">Desglose por Sucursal</h3>
                    <table style="border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
                        <thead>
                            <tr style="background:#19376D;">
                                <th style="padding:10px 12px;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;text-align:left;color:white;">Sucursal</th>
                                <th style="padding:10px 12px;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;text-align:center;color:white;">Total</th>
                                <th style="padding:10px 12px;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;text-align:center;color:white;">Críticos</th>
                                <th style="padding:10px 12px;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;text-align:center;color:white;">Altos</th>
                                <th style="padding:10px 12px;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;text-align:center;color:white;">Desconexiones</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${branchRows}
                        </tbody>
                    </table>
                    ` : ''}

                    ${insightsHtml}

                    <div style="background:#F0FDF4;border:1px solid #BBF7D0;border-radius:8px;padding:16px;margin-top:20px;">
                        <div style="font-size:14px;font-weight:600;color:#166534;margin-bottom:6px;">📊 ¿Cómo revisar estos eventos?</div>
                        <div style="font-size:13px;color:#15803D;line-height:1.6;">
                            Abre la aplicación <strong>SYA Tortillerías</strong> en tu computadora y navega a:<br>
                            <strong>Monitoreo de Seguridad</strong> (en el menú lateral) → Filtra por fecha para ver el detalle de cada evento,
                            marcarlos como revisados o exportar un reporte PDF completo.
                        </div>
                    </div>

                    <div class="opt-out">
                        <strong>Configurar o desactivar estos correos:</strong><br>
                        En la aplicación de escritorio: <strong>Configuración → Guardian Báscula</strong> (scroll abajo) →
                        sección <em>"Resumen Guardian por Email"</em>. Ahí puedes cambiar la frecuencia o desactivarlo.<br>
                        <span style="font-size:12px;color:#9ca3af;">Frecuencia actual: ${freqLabel} · Enviado a: ${to}</span>
                    </div>
                </div>

                <div class="footer">
                    <p><strong>SYA Tortillerías</strong> — Sistema de Gestión para Tortillerías</p>
                    <p style="font-size:11px;">Este correo es generado automáticamente por el sistema Guardian de monitoreo de báscula.</p>
                </div>
            </div>
        </body>
        </html>
    `;

    return await sendEmail({ to, subject, html });
}

module.exports = { sendGuardianDigestEmail, FRAUD_TYPE_LABELS };
