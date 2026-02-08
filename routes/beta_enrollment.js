// ═══════════════════════════════════════════════════════════════
// BETA ENROLLMENT ROUTES - Registro de interés en app móvil beta
// ═══════════════════════════════════════════════════════════════

const express = require('express');

module.exports = (pool) => {
    const router = express.Router();

    // POST /api/beta-enrollment - Registrar interés en la beta
    router.post('/', async (req, res) => {
        try {
            const { tenant_id, employee_id, email, business_name, platform } = req.body;

            if (!tenant_id || !email) {
                return res.status(400).json({
                    success: false,
                    message: 'tenant_id y email son requeridos'
                });
            }

            console.log(`[BetaEnrollment] 📱 Nuevo registro: ${email} (tenant: ${tenant_id}, negocio: ${business_name}, platform: ${platform || 'both'})`);

            const result = await pool.query(
                `INSERT INTO beta_enrollments (tenant_id, employee_id, email, business_name, platform)
                 VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (tenant_id)
                 DO UPDATE SET
                    email = EXCLUDED.email,
                    business_name = EXCLUDED.business_name,
                    platform = EXCLUDED.platform,
                    enrolled_at = NOW()
                 RETURNING *`,
                [tenant_id, employee_id || null, email, business_name || null, platform || 'both']
            );

            console.log(`[BetaEnrollment] ✅ Registrado: ${email}`);

            res.json({
                success: true,
                data: result.rows[0]
            });
        } catch (error) {
            console.error('[BetaEnrollment] ❌ Error:', error.message);
            res.status(500).json({
                success: false,
                message: 'Error al registrar interés en beta'
            });
        }
    });

    // GET /api/beta-enrollment/:tenantId - Consultar si ya está registrado
    router.get('/:tenantId', async (req, res) => {
        try {
            const { tenantId } = req.params;

            const result = await pool.query(
                'SELECT * FROM beta_enrollments WHERE tenant_id = $1',
                [tenantId]
            );

            if (result.rows.length > 0) {
                res.json({
                    success: true,
                    enrolled: true,
                    data: result.rows[0]
                });
            } else {
                res.json({
                    success: true,
                    enrolled: false,
                    data: null
                });
            }
        } catch (error) {
            console.error('[BetaEnrollment] ❌ Error:', error.message);
            res.status(500).json({
                success: false,
                message: 'Error al consultar estado de beta'
            });
        }
    });

    return router;
};
