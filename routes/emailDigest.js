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
// Endpoint temporal para enviar un email de prueba del Guardian digest
router.post('/test', authenticateToken, async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) {
            return res.status(400).json({ success: false, message: 'email requerido' });
        }

        const { sendGuardianDigestEmail } = require('../utils/guardianDigestEmail');
        const { sendLicenseExpiryEmail } = require('../utils/licenseExpiryEmail');

        // Enviar Guardian Digest de prueba
        const guardianSent = await sendGuardianDigestEmail({
            to: email,
            ownerName: 'Saul',
            businessName: 'SYA Tortillerías (Prueba)',
            frequency: 'biweekly',
            periodLabel: '25/02/2026 - 11/03/2026',
            branches: [
                { branchName: 'Sucursal Centro', totalEvents: 12, critical: 2, high: 3, disconnections: 1 },
                { branchName: 'Sucursal Norte', totalEvents: 5, critical: 0, high: 1, disconnections: 3 },
            ],
            totals: { totalEvents: 17, critical: 2, high: 4, disconnections: 4 }
        });

        // Enviar License Expiry de prueba
        const licenseSent = await sendLicenseExpiryEmail({
            to: email,
            ownerName: 'Saul',
            businessName: 'SYA Tortillerías (Prueba)',
            daysRemaining: 7,
            expiryDate: '18/03/2026',
            isTrial: true
        });

        res.json({
            success: true,
            guardianDigestSent: guardianSent,
            licenseExpirySent: licenseSent,
            sentTo: email
        });
    } catch (err) {
        console.error('[EmailDigest] Error test:', err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;
