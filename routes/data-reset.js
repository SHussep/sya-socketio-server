// ═══════════════════════════════════════════════════════════════
// DATA RESET ROUTES - Restablecer datos por sucursal o tenant
// Borra datos transaccionales INMEDIATAMENTE de PostgreSQL
// ═══════════════════════════════════════════════════════════════

const express = require('express');

// Tablas transaccionales a borrar por branch (orden por dependencias FK)
const BRANCH_TABLES = [
    // Hijas primero (FK a tablas padre)
    { table: 'ventas_detalle', via: 'id_venta', parent: 'ventas' },
    { table: 'notas_credito_detalle', via: 'nota_credito_id', parent: 'notas_credito' },
    { table: 'purchase_details', via: 'purchase_id', parent: 'purchases' },
    { table: 'inventory_transfer_items', via: 'transfer_id', parent: 'inventory_transfers' },
    // Directas con branch_id
    { table: 'repartidor_shift_cash_snapshot', col: 'branch_id' },
    { table: 'shift_cash_snapshot', col: 'branch_id' },
    { table: 'ventas', col: 'branch_id' },
    { table: 'notas_credito', col: 'branch_id' },
    { table: 'expenses', col: 'branch_id' },
    { table: 'cash_cuts', col: 'branch_id' },
    { table: 'deposits', col: 'branch_id' },
    { table: 'withdrawals', col: 'branch_id' },
    { table: 'shifts', col: 'branch_id' },
    { table: 'credit_payments', col: 'branch_id' },
    { table: 'purchases', col: 'branch_id' },
    { table: 'repartidor_assignments', col: 'branch_id' },
    { table: 'repartidor_returns', col: 'branch_id' },
    { table: 'repartidor_debts', col: 'branch_id' },
    { table: 'employee_debts', col: 'branch_id' },
    { table: 'preparation_mode_logs', col: 'branch_id' },
    { table: 'suspicious_weighing_logs', col: 'branch_id' },
    { table: 'scale_disconnection_logs', col: 'branch_id' },
    { table: 'cancelaciones_bitacora', col: 'branch_id' },
    { table: 'repartidor_locations', col: 'branch_id' },
    { table: 'gps_consent_log', col: 'branch_id' },
    { table: 'geofence_events', col: 'branch_id' },
    { table: 'employee_daily_metrics', col: 'branch_id' },
    { table: 'inventory_transfers', col: 'source_branch_id' },
    { table: 'guardian_employee_scores_daily', col: 'branch_id' },
    { table: 'suspicious_weighing_events', col: 'branch_id' },
    { table: 'scale_disconnections', col: 'branch_id' },
    { table: 'sessions', col: 'branch_id' },
    { table: 'backup_metadata', col: 'branch_id' },
];

/**
 * Borra datos transaccionales de una o varias branches
 * @returns {Object} { tabla: rowCount } de registros borrados
 */
async function purgeTransactionalData(client, tenantId, branchIds) {
    const deleted = {};

    for (const def of BRANCH_TABLES) {
        try {
            // Verificar si la tabla existe
            const exists = await client.query(
                `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = $1)`,
                [def.table]
            );
            if (!exists.rows[0].exists) continue;

            let result;

            if (def.parent) {
                // Tabla hija: borrar vía FK al padre
                const parentDef = BRANCH_TABLES.find(t => t.table === def.parent);
                const parentCol = parentDef?.col || 'branch_id';

                result = await client.query(`
                    DELETE FROM ${def.table}
                    WHERE ${def.via} IN (
                        SELECT id FROM ${def.parent}
                        WHERE ${parentCol} = ANY($1) AND tenant_id = $2
                    )
                `, [branchIds, tenantId]);
            } else {
                // Tabla directa con branch_id
                const hasTenant = await client.query(
                    `SELECT EXISTS (SELECT FROM information_schema.columns WHERE table_name = $1 AND column_name = 'tenant_id')`,
                    [def.table]
                );

                if (hasTenant.rows[0].exists) {
                    result = await client.query(
                        `DELETE FROM ${def.table} WHERE ${def.col} = ANY($1) AND tenant_id = $2`,
                        [branchIds, tenantId]
                    );
                } else {
                    result = await client.query(
                        `DELETE FROM ${def.table} WHERE ${def.col} = ANY($1)`,
                        [branchIds]
                    );
                }
            }

            if (result && result.rowCount > 0) {
                deleted[def.table] = result.rowCount;
                console.log(`[DATA-RESET]    🗑️ ${def.table}: ${result.rowCount} registros`);
            }
        } catch (err) {
            // Tabla puede no existir o tener schema diferente
            console.log(`[DATA-RESET]    ⚠️ ${def.table}: ${err.message}`);
        }
    }

    return deleted;
}

module.exports = (pool) => {
    const router = express.Router();

    // ─────────────────────────────────────────────────────────
    // POST /api/data-reset/branch/:branchId
    // Borra INMEDIATAMENTE datos transaccionales de una sucursal
    // Mantiene: employees, customers, productos, roles, branch
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

            console.log(`\n[DATA-RESET] 🔄 Reset de sucursal "${branchName}" (Branch ${branchId}, Tenant ${tenantId})`);

            await client.query('BEGIN');

            // 1. Borrar datos transaccionales INMEDIATAMENTE
            console.log('[DATA-RESET] 🗑️ Borrando datos transaccionales...');
            const deleted = await purgeTransactionalData(client, tenantId, [branchId]);

            // 2. Marcar data_reset_at en la branch
            await client.query(
                'UPDATE branches SET data_reset_at = $1 WHERE id = $2 AND tenant_id = $3',
                [resetAt, branchId, tenantId]
            );

            // 3. Registrar en auditoría
            await client.query(`
                INSERT INTO data_resets (tenant_id, branch_id, reset_scope, reset_at, purge_after, purged_at, requested_by_employee_id, requested_from, records_purged)
                VALUES ($1, $2, 'branch', $3, $3, $3, $4, $5, $6)
            `, [tenantId, branchId, resetAt, employeeId || null, source, JSON.stringify(deleted)]);

            await client.query('COMMIT');

            const totalDeleted = Object.values(deleted).reduce((a, b) => a + b, 0);
            console.log(`[DATA-RESET] ✅ Branch ${branchId} reseteada: ${totalDeleted} registros eliminados\n`);

            res.json({
                success: true,
                message: `Sucursal "${branchName}" restablecida — ${totalDeleted} registros eliminados`,
                data: {
                    branchId,
                    branchName,
                    resetAt: resetAt.toISOString(),
                    totalDeleted,
                    deleted
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
    // Borra INMEDIATAMENTE datos de TODAS las sucursales del tenant
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

            // Obtener todas las branches del tenant
            const branchesResult = await client.query(
                'SELECT id, name FROM branches WHERE tenant_id = $1',
                [tenantId]
            );
            const branches = branchesResult.rows;
            const branchIds = branches.map(b => b.id);

            console.log(`\n[DATA-RESET] 🔄 Reset COMPLETO de tenant ${tenantId} (${branches.length} sucursales)`);

            await client.query('BEGIN');

            // 1. Borrar datos transaccionales de TODAS las branches
            console.log('[DATA-RESET] 🗑️ Borrando datos transaccionales de todas las sucursales...');
            const deleted = await purgeTransactionalData(client, tenantId, branchIds);

            // 2. Marcar data_reset_at en TODAS las branches
            await client.query(
                'UPDATE branches SET data_reset_at = $1 WHERE tenant_id = $2',
                [resetAt, tenantId]
            );

            // 3. Auditoría
            await client.query(`
                INSERT INTO data_resets (tenant_id, branch_id, reset_scope, reset_at, purge_after, purged_at, requested_by_employee_id, requested_from, records_purged)
                VALUES ($1, NULL, 'tenant', $2, $2, $2, $3, $4, $5)
            `, [tenantId, resetAt, employeeId || null, source, JSON.stringify(deleted)]);

            await client.query('COMMIT');

            const totalDeleted = Object.values(deleted).reduce((a, b) => a + b, 0);
            console.log(`[DATA-RESET] ✅ Tenant ${tenantId} reseteado: ${totalDeleted} registros eliminados\n`);

            res.json({
                success: true,
                message: `${branches.length} sucursales restablecidas — ${totalDeleted} registros eliminados`,
                data: {
                    tenantId,
                    resetAt: resetAt.toISOString(),
                    totalDeleted,
                    deleted,
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
