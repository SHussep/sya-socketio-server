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

        const { sendGuardianDigestEmail } = require('../utils/guardianDigestEmail');
        const { sendLicenseExpiryEmail } = require('../utils/licenseExpiryEmail');

        let guardianSent = false;
        let licenseSent = false;

        if (tenant_id) {
            // ══════════════════════════════════════════════════
            // DATOS REALES del tenant
            // ══════════════════════════════════════════════════
            const { rows: tenantRows } = await pool.query(
                `SELECT id, business_name, subscription_status, trial_ends_at, subscription_ends_at
                 FROM tenants WHERE id = $1`, [tenant_id]
            );
            if (tenantRows.length === 0) {
                return res.status(404).json({ success: false, message: 'Tenant no encontrado' });
            }
            const tenant = tenantRows[0];

            // Owner
            const { rows: owners } = await pool.query(
                `SELECT first_name, last_name FROM employees
                 WHERE tenant_id = $1 AND is_owner = true AND is_active = true LIMIT 1`, [tenant_id]
            );
            const ownerName = owners.length > 0
                ? `${owners[0].first_name || ''} ${owners[0].last_name || ''}`.trim() || 'Propietario'
                : 'Propietario';

            // Branches
            const { rows: branches } = await pool.query(
                `SELECT id, name FROM branches WHERE tenant_id = $1 AND is_active = true ORDER BY name`, [tenant_id]
            );

            // Período: este mes
            const now = new Date();
            const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
            const lookback = `${Math.ceil((now - startOfMonth) / (1000 * 60 * 60 * 24))} days`;

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

            const fmtDate = (d) => `${d.getDate().toString().padStart(2,'0')}/${(d.getMonth()+1).toString().padStart(2,'0')}/${d.getFullYear()}`;

            guardianSent = await sendGuardianDigestEmail({
                to: email,
                ownerName,
                businessName: tenant.business_name,
                frequency: 'monthly',
                periodLabel: `${fmtDate(startOfMonth)} - ${fmtDate(now)}`,
                branches: branchData,
                totals: { totalEvents: grandTotal, critical: grandCritical, high: grandHigh, disconnections: grandDisc }
            });

            // License expiry
            const isTrial = tenant.subscription_status === 'trial';
            const expiryDate = isTrial ? tenant.trial_ends_at : tenant.subscription_ends_at;
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
                totalEvents: grandTotal
            });
        } else {
            // Datos de ejemplo
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
                totals: { totalEvents: 17, critical: 2, high: 4, disconnections: 4 }
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
