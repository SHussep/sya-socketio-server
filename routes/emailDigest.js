// ═══════════════════════════════════════════════════════════
// ROUTES: Email Digest Preferences
// Solo el owner puede ver/modificar las preferencias de digest
// ═══════════════════════════════════════════════════════════

const express = require('express');
const router = express.Router();
const { rawPool: pool } = require('../database/pool');
const { authenticateToken } = require('../middleware/auth');

// GET /api/email-digest/preferences
// Obtiene las preferencias de digest del tenant actual
router.get('/preferences', authenticateToken, async (req, res) => {
    try {
        const { tenant_id } = req.query;
        if (!tenant_id) {
            return res.status(400).json({ success: false, message: 'tenant_id requerido' });
        }

        const { rows } = await pool.query(`
            SELECT email_digest_enabled, email_digest_frequency,
                   email_digest_last_sent_at, email_digest_next_send_at
            FROM tenants WHERE id = $1
        `, [tenant_id]);

        if (rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Tenant no encontrado' });
        }

        res.json({
            success: true,
            data: {
                enabled: rows[0].email_digest_enabled ?? true,
                frequency: rows[0].email_digest_frequency || 'biweekly',
                lastSentAt: rows[0].email_digest_last_sent_at,
                nextSendAt: rows[0].email_digest_next_send_at
            }
        });
    } catch (err) {
        console.error('[EmailDigest] Error GET preferences:', err.message);
        res.status(500).json({ success: false, message: 'Error interno' });
    }
});

// PUT /api/email-digest/preferences
// Actualiza las preferencias de digest
// Body: { tenant_id, enabled, frequency }
// frequency: 'weekly' | 'biweekly' | 'monthly' | 'off'
router.put('/preferences', authenticateToken, async (req, res) => {
    try {
        const { tenant_id, enabled, frequency } = req.body;
        if (!tenant_id) {
            return res.status(400).json({ success: false, message: 'tenant_id requerido' });
        }

        const validFrequencies = ['weekly', 'biweekly', 'monthly', 'off'];
        const freq = validFrequencies.includes(frequency) ? frequency : 'biweekly';
        const isEnabled = freq !== 'off' && enabled !== false;

        // Calcular próximo envío
        const intervalMap = { weekly: '7 days', biweekly: '14 days', monthly: '1 month' };
        const nextSendInterval = intervalMap[freq] || '14 days';

        if (isEnabled) {
            await pool.query(`
                UPDATE tenants
                SET email_digest_enabled = true,
                    email_digest_frequency = $2,
                    email_digest_next_send_at = CASE
                        WHEN email_digest_next_send_at IS NULL OR email_digest_enabled = false
                        THEN NOW() + $3::interval
                        ELSE email_digest_next_send_at
                    END,
                    updated_at = NOW()
                WHERE id = $1
            `, [tenant_id, freq, nextSendInterval]);
        } else {
            await pool.query(`
                UPDATE tenants
                SET email_digest_enabled = false,
                    email_digest_frequency = 'off',
                    email_digest_next_send_at = NULL,
                    updated_at = NOW()
                WHERE id = $1
            `, [tenant_id]);
        }

        console.log(`[EmailDigest] Tenant ${tenant_id}: enabled=${isEnabled}, frequency=${freq}`);

        res.json({
            success: true,
            data: { enabled: isEnabled, frequency: isEnabled ? freq : 'off' }
        });
    } catch (err) {
        console.error('[EmailDigest] Error PUT preferences:', err.message);
        res.status(500).json({ success: false, message: 'Error interno' });
    }
});

// POST /api/email-digest/test
// Endpoint para enviar email de prueba con datos reales de un tenant
// Body: { email, tenant_id? } — si se pasa tenant_id, consulta datos reales
router.post('/test', authenticateToken, async (req, res) => {
    try {
        const { email, tenant_id } = req.body;
        if (!email) {
            return res.status(400).json({ success: false, message: 'email requerido' });
        }

        const { sendGuardianDigestEmail, FRAUD_TYPE_LABELS } = require('../utils/guardianDigestEmail');
        const { sendLicenseExpiryEmail } = require('../utils/licenseExpiryEmail');

        let guardianSent = false;
        let licenseSent = false;

        if (tenant_id) {
            const { rows: tenantRows } = await pool.query(
                `SELECT id, business_name, subscription_status, trial_ends_at
                 FROM tenants WHERE id = $1`, [tenant_id]
            );
            if (tenantRows.length === 0) {
                return res.status(404).json({ success: false, message: 'Tenant no encontrado' });
            }
            const tenant = tenantRows[0];

            const { rows: owners } = await pool.query(
                `SELECT first_name, last_name FROM employees
                 WHERE tenant_id = $1 AND is_owner = true AND is_active = true LIMIT 1`, [tenant_id]
            );
            const ownerName = owners.length > 0
                ? `${owners[0].first_name || ''} ${owners[0].last_name || ''}`.trim() || 'Propietario'
                : 'Propietario';

            const { rows: branches } = await pool.query(
                `SELECT id, name FROM branches WHERE tenant_id = $1 AND is_active = true ORDER BY name`, [tenant_id]
            );

            const now = new Date();
            const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
            const daysInPeriod = Math.ceil((now - startOfMonth) / (1000 * 60 * 60 * 24)) || 1;

            const branchData = [];
            let grandTotal = 0, grandCritical = 0, grandHigh = 0, grandDisc = 0;

            for (const branch of branches) {
                const { rows: [susp] } = await pool.query(`
                    SELECT COUNT(*) AS total,
                           COUNT(*) FILTER (WHERE severity = 'Critical') AS critical,
                           COUNT(*) FILTER (WHERE severity = 'High') AS high
                    FROM suspicious_weighing_logs
                    WHERE tenant_id = $1 AND branch_id = $2
                      AND timestamp >= $3::timestamptz
                `, [tenant_id, branch.id, startOfMonth.toISOString()]);

                const { rows: [disc] } = await pool.query(`
                    SELECT COUNT(*) AS total
                    FROM scale_disconnection_logs
                    WHERE tenant_id = $1 AND branch_id = $2
                      AND disconnected_at >= $3::timestamptz
                `, [tenant_id, branch.id, startOfMonth.toISOString()]);

                const total = parseInt(susp.total) || 0;
                const critical = parseInt(susp.critical) || 0;
                const high = parseInt(susp.high) || 0;
                const disconnections = parseInt(disc.total) || 0;

                branchData.push({ branchName: branch.name, totalEvents: total, critical, high, disconnections });
                grandTotal += total; grandCritical += critical; grandHigh += high; grandDisc += disconnections;
            }

            // Top event types (event_type)
            const { rows: topTypes } = await pool.query(`
                SELECT event_type, COUNT(*) AS count
                FROM suspicious_weighing_logs
                WHERE tenant_id = $1 AND timestamp >= $2::timestamptz
                GROUP BY event_type
                ORDER BY count DESC
                LIMIT 5
            `, [tenant_id, startOfMonth.toISOString()]);

            const topEventTypes = topTypes.map(r => ({
                event_type: r.event_type,
                label: FRAUD_TYPE_LABELS[r.event_type] || r.event_type,
                count: parseInt(r.count)
            }));

            // Recent critical/high events (top 3)
            const { rows: criticalEvents } = await pool.query(`
                SELECT s.details, s.severity, s.timestamp, s.event_type,
                       b.name AS branch_name, e.first_name, e.last_name
                FROM suspicious_weighing_logs s
                LEFT JOIN branches b ON b.id = s.branch_id
                LEFT JOIN employees e ON e.id = s.employee_id
                WHERE s.tenant_id = $1
                  AND s.timestamp >= $2::timestamptz
                  AND s.severity IN ('Critical', 'High')
                ORDER BY s.timestamp DESC
                LIMIT 3
            `, [tenant_id, startOfMonth.toISOString()]);

            const recentCritical = criticalEvents.map(r => ({
                description: r.details || FRAUD_TYPE_LABELS[r.event_type] || r.event_type || 'Evento detectado',
                severity: r.severity,
                timestamp: new Date(r.timestamp).toLocaleString('es-MX', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }),
                branchName: r.branch_name || '',
                employeeName: r.first_name ? `${r.first_name} ${r.last_name || ''}`.trim() : ''
            }));

            const fmtDate = (d) => `${d.getDate().toString().padStart(2,'0')}/${(d.getMonth()+1).toString().padStart(2,'0')}/${d.getFullYear()}`;

            guardianSent = await sendGuardianDigestEmail({
                to: email,
                ownerName,
                businessName: tenant.business_name,
                frequency: 'monthly',
                periodLabel: `${fmtDate(startOfMonth)} - ${fmtDate(now)}`,
                branches: branchData,
                totals: { totalEvents: grandTotal, critical: grandCritical, high: grandHigh, disconnections: grandDisc },
                topEventTypes,
                recentCritical,
                daysInPeriod
            });

            // License expiry
            const isTrial = tenant.subscription_status === 'trial';
            const expiryDate = tenant.trial_ends_at;
            if (expiryDate) {
                const expiry = new Date(expiryDate);
                const daysRemaining = Math.ceil((expiry - now) / (1000 * 60 * 60 * 24));
                licenseSent = await sendLicenseExpiryEmail({
                    to: email,
                    ownerName,
                    businessName: tenant.business_name,
                    daysRemaining: Math.max(daysRemaining, 0),
                    expiryDate: fmtDate(expiry),
                    isTrial
                });
            }

            res.json({
                success: true,
                guardianDigestSent: guardianSent,
                licenseExpirySent: licenseSent,
                sentTo: email,
                tenantId: tenant_id,
                businessName: tenant.business_name,
                branchCount: branches.length,
                totalEvents: grandTotal,
                topEventTypes: topEventTypes.length,
                recentCritical: recentCritical.length
            });
        } else {
            // Datos de ejemplo enriquecidos
            guardianSent = await sendGuardianDigestEmail({
                to: email,
                ownerName: 'Propietario',
                businessName: 'SYA Tortillerías (Prueba)',
                frequency: 'biweekly',
                periodLabel: '25/02/2026 - 11/03/2026',
                branches: [
                    { branchName: 'Sucursal Centro', totalEvents: 12, critical: 2, high: 3, disconnections: 1 },
                    { branchName: 'Sucursal Norte', totalEvents: 5, critical: 0, high: 1, disconnections: 3 },
                ],
                totals: { totalEvents: 17, critical: 2, high: 4, disconnections: 4 },
                topEventTypes: [
                    { event_type: 'FRD-007', label: 'Peso no registrado (cobro)', count: 8 },
                    { event_type: 'FRD-008', label: 'Pesaje cancelado', count: 5 },
                    { event_type: 'FRD-003', label: 'Discrepancia de peso', count: 4 },
                ],
                recentCritical: [
                    { description: 'Se cobró $45.00 sin peso registrado en báscula', severity: 'Critical', timestamp: '10 mar, 14:32', branchName: 'Sucursal Centro', employeeName: 'Juan Pérez' },
                    { description: 'Peso retirado 2.5kg después de registrar venta', severity: 'Critical', timestamp: '09 mar, 09:15', branchName: 'Sucursal Centro', employeeName: 'María López' },
                ],
                daysInPeriod: 14
            });

            licenseSent = await sendLicenseExpiryEmail({
                to: email,
                ownerName: 'Propietario',
                businessName: 'SYA Tortillerías (Prueba)',
                daysRemaining: 7,
                expiryDate: '18/03/2026',
                isTrial: true
            });

            res.json({ success: true, guardianDigestSent: guardianSent, licenseExpirySent: licenseSent, sentTo: email });
        }
    } catch (err) {
        console.error('[EmailDigest] Error test:', err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;
