// ═══════════════════════════════════════════════════════════════
// BETA ENROLLMENT ROUTES - Registro de interés en app móvil beta
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const { notifySuperadmins } = require('../utils/superadminNotifier');

module.exports = (pool) => {
    const router = express.Router();

    // POST /api/beta-enrollment - Registrar interés en la beta
    // Acepta:
    //   Forma nueva: { tenant_id, business_name, emails: [{email, platform}] }
    //   Forma vieja: { tenant_id, employee_id, email, business_name, platform }  (compat shim)
    router.post('/', async (req, res) => {
        const client = await pool.connect();
        try {
            const { tenant_id, business_name } = req.body;
            let emails = req.body.emails;

            // Compat shim: forma vieja → array de 1
            if (!Array.isArray(emails)) {
                if (req.body.email) {
                    emails = [{
                        email: req.body.email,
                        platform: req.body.platform || 'both',
                    }];
                } else {
                    emails = [];
                }
            }

            if (!tenant_id) {
                return res.status(400).json({ success: false, message: 'tenant_id es requerido' });
            }
            if (!emails.length) {
                return res.status(400).json({ success: false, message: 'al menos un email requerido' });
            }
            if (emails.length > 5) {
                return res.status(400).json({ success: false, message: 'máximo 5 correos por tenant' });
            }

            // Validación de cada email
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            const validPlatforms = new Set(['ios', 'android', 'both']);
            const seen = new Set();
            for (const e of emails) {
                if (!e.email || !emailRegex.test(e.email)) {
                    return res.status(400).json({ success: false, message: `email inválido: ${e.email}` });
                }
                const key = e.email.toLowerCase();
                if (seen.has(key)) {
                    return res.status(400).json({ success: false, message: `email duplicado: ${e.email}` });
                }
                seen.add(key);
                if (!validPlatforms.has(e.platform || 'both')) {
                    return res.status(400).json({ success: false, message: `platform inválido: ${e.platform}` });
                }
            }

            // ¿Es la primera vez para este tenant? (para decidir si notifica)
            const existingCount = await client.query(
                'SELECT COUNT(*)::int AS c FROM beta_enrollment_emails WHERE tenant_id = $1',
                [tenant_id]
            );
            const isFirstTime = existingCount.rows[0].c === 0;

            await client.query('BEGIN');
            try {
                // 1) Eliminar correos que ya no están en la lista nueva
                const lowercased = emails.map(e => e.email.toLowerCase());
                await client.query(
                    `DELETE FROM beta_enrollment_emails
                     WHERE tenant_id = $1
                       AND lower(email) <> ALL($2::text[])`,
                    [tenant_id, lowercased]
                );

                // 2) Insertar nuevos / actualizar platform de existentes
                for (const e of emails) {
                    await client.query(
                        `INSERT INTO beta_enrollment_emails (tenant_id, email, platform)
                         VALUES ($1, $2, $3)
                         ON CONFLICT (tenant_id, lower(email))
                         DO UPDATE SET platform = EXCLUDED.platform`,
                        [tenant_id, e.email, e.platform || 'both']
                    );
                }

                await client.query('COMMIT');
            } catch (txErr) {
                await client.query('ROLLBACK');
                throw txErr;
            }

            // Recuperar lista actualizada
            const updated = await client.query(
                `SELECT id, email, platform, enrolled_at, invitation_sent_at
                 FROM beta_enrollment_emails
                 WHERE tenant_id = $1
                 ORDER BY enrolled_at`,
                [tenant_id]
            );

            console.log(`[BetaEnrollment] ✅ Registrado tenant=${tenant_id}, ${emails.length} correos`);

            // Notificación push (solo primera vez)
            if (isFirstTime) {
                const platforms = [...new Set(emails.map(e => e.platform || 'both'))].join(', ');
                notifySuperadmins(
                    '🧪 Nueva solicitud Beta',
                    `${business_name || emails[0].email} pidió enrolarse (${platforms})`,
                    {
                        type: 'beta_enrollment',
                        tenant_id,
                        email: emails[0].email,
                        platform: platforms,
                    }
                ).catch(err =>
                    console.error('[BetaEnrollment] Error notif SuperAdmin:', err.message)
                );
            }

            res.json({ success: true, data: updated.rows });
        } catch (error) {
            console.error('[BetaEnrollment] ❌ Error:', error.message);
            res.status(500).json({ success: false, message: 'Error al registrar interés en beta' });
        } finally {
            client.release();
        }
    });

    // GET /api/beta-enrollment/:tenantId - Lista de correos del tenant
    router.get('/:tenantId', async (req, res) => {
        try {
            const { tenantId } = req.params;
            const result = await pool.query(
                `SELECT id, email, platform, enrolled_at, invitation_sent_at
                 FROM beta_enrollment_emails
                 WHERE tenant_id = $1
                 ORDER BY enrolled_at`,
                [tenantId]
            );
            res.json({
                success: true,
                enrolled: result.rows.length > 0,
                emails: result.rows,
            });
        } catch (error) {
            console.error('[BetaEnrollment] ❌ Error:', error.message);
            res.status(500).json({ success: false, message: 'Error al consultar beta' });
        }
    });

    return router;
};
