// ═══════════════════════════════════════════════════════════════
// DATA RESET ROUTES - Restablecer datos por sucursal o tenant
// ═══════════════════════════════════════════════════════════════

const express = require('express');

module.exports = (pool) => {
    const router = express.Router();

    // ─────────────────────────────────────────────────────────
    // POST /api/data-reset/branch/:branchId
    // Marca una sucursal como "reseteada" (soft reset)
    // El sync ignorará datos anteriores a data_reset_at
    // El job de purga eliminará datos viejos después de 30 días
    // No requiere JWT — usa tenantId/branchId del body (desktop offline-first)
    // ─────────────────────────────────────────────────────────
    router.post('/branch/:branchId', async (req, res) => {
        const client = await pool.connect();
        try {
            const branchId = parseInt(req.params.branchId);
            const tenantId = req.body.tenantId;
            const employeeId = req.body.employeeId;
            const source = req.body.source || 'desktop';

            if (!branchId || !tenantId) {
                return res.status(400).json({
                    success: false,
                    message: 'branchId y tenantId son requeridos'
                });
            }

            // Verificar que la sucursal pertenece al tenant
            const branchCheck = await client.query(
                'SELECT id, name FROM branches WHERE id = $1 AND tenant_id = $2',
                [branchId, tenantId]
            );

            if (branchCheck.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Sucursal no encontrada o no pertenece a tu cuenta'
                });
            }

            const branchName = branchCheck.rows[0].name;
            const resetAt = new Date();
            const purgeAfter = new Date(resetAt.getTime() + 30 * 24 * 60 * 60 * 1000); // +30 días

            console.log(`\n[DATA-RESET] 🔄 Reset de sucursal solicitado`);
            console.log(`[DATA-RESET]    Tenant: ${tenantId}, Branch: ${branchId} (${branchName})`);
            console.log(`[DATA-RESET]    Reset at: ${resetAt.toISOString()}`);
            console.log(`[DATA-RESET]    Purge after: ${purgeAfter.toISOString()}`);

            await client.query('BEGIN');

            // 1. Marcar la sucursal con data_reset_at
            await client.query(
                'UPDATE branches SET data_reset_at = $1 WHERE id = $2 AND tenant_id = $3',
                [resetAt, branchId, tenantId]
            );

            // 2. Registrar en auditoría
            await client.query(`
                INSERT INTO data_resets (tenant_id, branch_id, reset_scope, reset_at, purge_after, requested_by_employee_id, requested_from)
                VALUES ($1, $2, 'branch', $3, $4, $5, $6)
            `, [tenantId, branchId, resetAt, purgeAfter, employeeId || null, source]);

            await client.query('COMMIT');

            console.log(`[DATA-RESET] ✅ Branch ${branchId} marcada para reset. Purga programada: ${purgeAfter.toISOString()}\n`);

            res.json({
                success: true,
                message: `Sucursal "${branchName}" marcada para restablecimiento`,
                data: {
                    branchId,
                    branchName,
                    resetAt: resetAt.toISOString(),
                    purgeAfter: purgeAfter.toISOString(),
                    syncNote: 'El sync ignorará datos anteriores a esta fecha'
                }
            });

        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            console.error('[DATA-RESET] ❌ Error:', error.message);
            res.status(500).json({ success: false, message: 'Error al restablecer datos', error: error.message });
        } finally {
            client.release();
        }
    });

    // ─────────────────────────────────────────────────────────
    // POST /api/data-reset/tenant
    // Resetea TODAS las sucursales del tenant (solo owner)
    // ─────────────────────────────────────────────────────────
    router.post('/tenant', async (req, res) => {
        const client = await pool.connect();
        try {
            const tenantId = req.body.tenantId;
            const employeeId = req.body.employeeId;
            const source = req.body.source || 'desktop';

            if (!tenantId) {
                return res.status(400).json({
                    success: false,
                    message: 'tenantId es requerido'
                });
            }

            const resetAt = new Date();
            const purgeAfter = new Date(resetAt.getTime() + 30 * 24 * 60 * 60 * 1000);

            console.log(`\n[DATA-RESET] 🔄 Reset COMPLETO de tenant solicitado`);
            console.log(`[DATA-RESET]    Tenant: ${tenantId}`);

            await client.query('BEGIN');

            // 1. Marcar TODAS las sucursales del tenant
            const updateResult = await client.query(
                'UPDATE branches SET data_reset_at = $1 WHERE tenant_id = $2 RETURNING id, name',
                [resetAt, tenantId]
            );

            // 2. Registrar en auditoría (scope = 'tenant', branch_id = NULL)
            await client.query(`
                INSERT INTO data_resets (tenant_id, branch_id, reset_scope, reset_at, purge_after, requested_by_employee_id, requested_from)
                VALUES ($1, NULL, 'tenant', $2, $3, $4, $5)
            `, [tenantId, resetAt, purgeAfter, employeeId || null, source]);

            await client.query('COMMIT');

            const branches = updateResult.rows;
            console.log(`[DATA-RESET] ✅ ${branches.length} sucursales marcadas para reset\n`);

            res.json({
                success: true,
                message: `${branches.length} sucursales restablecidas`,
                data: {
                    tenantId,
                    resetAt: resetAt.toISOString(),
                    purgeAfter: purgeAfter.toISOString(),
                    branches: branches.map(b => ({ id: b.id, name: b.name }))
                }
            });

        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            console.error('[DATA-RESET] ❌ Error:', error.message);
            res.status(500).json({ success: false, message: 'Error al restablecer datos', error: error.message });
        } finally {
            client.release();
        }
    });

    // ─────────────────────────────────────────────────────────
    // GET /api/data-reset/status/:tenantId
    // Ver historial de resets del tenant
    // ─────────────────────────────────────────────────────────
    router.get('/status/:tenantId', async (req, res) => {
        try {
            const tenantId = parseInt(req.params.tenantId);

            const resets = await pool.query(`
                SELECT dr.*, b.name as branch_name
                FROM data_resets dr
                LEFT JOIN branches b ON dr.branch_id = b.id
                WHERE dr.tenant_id = $1
                ORDER BY dr.reset_at DESC
                LIMIT 20
            `, [tenantId]);

            const branches = await pool.query(`
                SELECT id, name, data_reset_at
                FROM branches
                WHERE tenant_id = $1
                ORDER BY id
            `, [tenantId]);

            res.json({
                success: true,
                data: {
                    branches: branches.rows,
                    resets: resets.rows
                }
            });
        } catch (error) {
            console.error('[DATA-RESET] ❌ Error:', error.message);
            res.status(500).json({ success: false, message: 'Error al obtener estado' });
        }
    });

    return router;
};
