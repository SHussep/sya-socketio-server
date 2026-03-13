// ═══════════════════════════════════════════════════════════════
// DATA RESET ROUTES - Restablecer datos por sucursal o tenant
// Reutiliza las mismas tablas de scripts/db-cleanup.js
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { FULL_CLEANUP_TABLES, PARTIAL_CLEANUP_TABLES } = require('../utils/cleanupTables');

// Helpers (misma lógica que db-cleanup.js)
async function tableExists(client, tableName) {
    const result = await client.query(
        `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = $1)`,
        [tableName]
    );
    return result.rows[0].exists;
}

async function columnExists(client, tableName, columnName) {
    const result = await client.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
        [tableName, columnName]
    );
    return result.rows.length > 0;
}

/**
 * Verifica que el empleado sea owner o admin del tenant.
 * Usa mobile_access_type del rol (NO role_id hardcodeado, ya que es auto-increment por tenant).
 */
async function requireOwnerOrAdmin(pool, employeeId, tenantId) {
    const result = await pool.query(`
        SELECT e.is_owner, r.mobile_access_type
        FROM employees e
        LEFT JOIN roles r ON e.role_id = r.id AND e.tenant_id = r.tenant_id
        WHERE e.id = $1 AND e.tenant_id = $2 AND e.is_active = true
    `, [employeeId, tenantId]);
    if (result.rows.length === 0) return { allowed: false, reason: 'Empleado no encontrado o inactivo' };
    const emp = result.rows[0];
    if (!emp.is_owner && emp.mobile_access_type !== 'admin') {
        return { allowed: false, reason: 'Solo el propietario o administradores pueden restablecer datos' };
    }
    return { allowed: true, isOwner: emp.is_owner };
}

async function removeGenericCustomerProtection(client, tenantId) {
    try {
        const result = await client.query(
            `UPDATE customers SET is_system_generic = false WHERE tenant_id = $1 AND is_system_generic = true`,
            [tenantId]
        );
        return result.rowCount;
    } catch (err) {
        return 0;
    }
}

/**
 * Borra datos de un tenant
 * @param {string} mode - 'partial' = solo transaccional, 'full' = todo menos tenant/branches
 */
async function deleteAllData(client, tenantId, mode = 'full') {
    const deleted = {};

    // Seleccionar tablas según modo
    let tables;
    if (mode === 'partial') {
        // Solo tablas transaccionales (ventas, turnos, gastos, etc.)
        // Conserva: empleados, clientes, productos, roles, config
        tables = PARTIAL_CLEANUP_TABLES;
    } else {
        // Todo excepto tenant y branches (structural)
        tables = FULL_CLEANUP_TABLES.filter(t => !t.structural);
    }

    // Quitar protección del cliente genérico (solo en modo full que borra clientes)
    if (mode === 'full') {
        const genericRemoved = await removeGenericCustomerProtection(client, tenantId);
        if (genericRemoved > 0) {
            console.log(`[DATA-RESET]    🔓 ${genericRemoved} cliente(s) genérico(s) desprotegido(s)`);
        }
    }

    for (const tableConfig of tables) {
        const sp = `sp_${tableConfig.name.replace(/[^a-z0-9_]/g, '')}`;
        try {
            await client.query(`SAVEPOINT ${sp}`);

            const exists = await tableExists(client, tableConfig.name);
            if (!exists) {
                await client.query(`RELEASE SAVEPOINT ${sp}`);
                continue;
            }

            let query, params;

            if (tableConfig.isTenantTable) {
                query = `DELETE FROM ${tableConfig.name} WHERE id = $1`;
                params = [tenantId];
            } else if (tableConfig.customQuery === 'employee_id') {
                const hasCol = await columnExists(client, tableConfig.name, 'employee_id');
                if (!hasCol) {
                    await client.query(`RELEASE SAVEPOINT ${sp}`);
                    continue;
                }
                query = `DELETE FROM ${tableConfig.name} dt WHERE EXISTS (SELECT 1 FROM employees e WHERE e.id = dt.employee_id AND e.tenant_id = $1)`;
                params = [tenantId];
            } else {
                const fkCol = tableConfig.fkColumn || 'tenant_id';
                const hasCol = await columnExists(client, tableConfig.name, fkCol);
                if (!hasCol) {
                    await client.query(`RELEASE SAVEPOINT ${sp}`);
                    continue;
                }
                query = `DELETE FROM ${tableConfig.name} WHERE ${fkCol} = $1`;
                params = [tenantId];
            }

            const result = await client.query(query, params);
            await client.query(`RELEASE SAVEPOINT ${sp}`);

            if (result.rowCount > 0) {
                deleted[tableConfig.name] = result.rowCount;
                console.log(`[DATA-RESET]    🗑️ ${tableConfig.name}: ${result.rowCount}`);
            }
        } catch (err) {
            await client.query(`ROLLBACK TO SAVEPOINT ${sp}`).catch(() => {});
            console.log(`[DATA-RESET]    ⚠️ ${tableConfig.name}: ${err.message}`);
        }
    }

    return deleted;
}

module.exports = (pool) => {
    const router = express.Router();

    // ─────────────────────────────────────────────────────────
    // POST /api/data-reset/branch/:branchId
    // mode=partial: solo transaccional (ventas, turnos, etc.)
    // mode=full: todo excepto tenant/branches
    // ─────────────────────────────────────────────────────────
    router.post('/branch/:branchId', authenticateToken, async (req, res) => {
        const client = await pool.connect();
        try {
            const branchId = parseInt(req.params.branchId);
            const tenantId = req.user.tenantId;
            const employeeId = req.body.employeeId;
            const source = req.body.source || 'desktop';
            const mode = req.body.mode === 'partial' ? 'partial' : 'full';

            if (!branchId || !tenantId) {
                return res.status(400).json({ success: false, message: 'branchId y tenantId son requeridos' });
            }

            // Role check: solo owner o admin pueden restablecer datos
            const authCheck = await requireOwnerOrAdmin(pool, req.user.employeeId, tenantId);
            if (!authCheck.allowed) {
                client.release();
                return res.status(403).json({ success: false, message: authCheck.reason });
            }

            const branchCheck = await client.query(
                'SELECT id, name FROM branches WHERE id = $1 AND tenant_id = $2',
                [branchId, tenantId]
            );
            if (branchCheck.rows.length === 0) {
                return res.status(404).json({ success: false, message: 'Sucursal no encontrada' });
            }

            const branchName = branchCheck.rows[0].name;
            const resetAt = new Date();

            console.log(`\n[DATA-RESET] 🔄 Reset ${mode.toUpperCase()} "${branchName}" (Branch ${branchId}, Tenant ${tenantId})`);

            await client.query('BEGIN');

            const deleted = await deleteAllData(client, tenantId, mode);

            // Marcar data_reset_at
            await client.query(
                'UPDATE branches SET data_reset_at = $1 WHERE id = $2 AND tenant_id = $3',
                [resetAt, branchId, tenantId]
            );

            // Auditoría
            await client.query(`
                INSERT INTO data_resets (tenant_id, branch_id, reset_scope, reset_at, purge_after, purged_at, requested_by_employee_id, requested_from, records_purged)
                VALUES ($1, $2, $3, $4, $4, $4, $5, $6, $7)
            `, [tenantId, branchId, `branch-${mode}`, resetAt, employeeId || null, source, JSON.stringify(deleted)]);

            await client.query('COMMIT');

            const totalDeleted = Object.values(deleted).reduce((a, b) => a + b, 0);
            console.log(`[DATA-RESET] ✅ Tenant ${tenantId} (${mode}): ${totalDeleted} registros eliminados\n`);

            res.json({
                success: true,
                message: `"${branchName}" restablecida (${mode}) — ${totalDeleted} registros eliminados`,
                data: { branchId, branchName, mode, resetAt: resetAt.toISOString(), totalDeleted, deleted }
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
    // mode=partial o mode=full para TODAS las sucursales
    // ─────────────────────────────────────────────────────────
    router.post('/tenant', authenticateToken, async (req, res) => {
        const client = await pool.connect();
        try {
            const tenantId = req.user.tenantId;
            const employeeId = req.body.employeeId;
            const source = req.body.source || 'desktop';
            const mode = req.body.mode === 'partial' ? 'partial' : 'full';

            if (!tenantId) {
                return res.status(400).json({ success: false, message: 'tenantId es requerido' });
            }

            // Role check: solo owner o admin pueden restablecer datos
            const authCheck = await requireOwnerOrAdmin(pool, req.user.employeeId, tenantId);
            if (!authCheck.allowed) {
                client.release();
                return res.status(403).json({ success: false, message: authCheck.reason });
            }

            const branchesResult = await client.query(
                'SELECT id, name FROM branches WHERE tenant_id = $1', [tenantId]
            );
            const branches = branchesResult.rows;
            const resetAt = new Date();

            console.log(`\n[DATA-RESET] 🔄 Reset ${mode.toUpperCase()} tenant ${tenantId} (${branches.length} sucursales)`);

            await client.query('BEGIN');

            const deleted = await deleteAllData(client, tenantId, mode);

            await client.query(
                'UPDATE branches SET data_reset_at = $1 WHERE tenant_id = $2',
                [resetAt, tenantId]
            );

            await client.query(`
                INSERT INTO data_resets (tenant_id, branch_id, reset_scope, reset_at, purge_after, purged_at, requested_by_employee_id, requested_from, records_purged)
                VALUES ($1, NULL, $2, $3, $3, $3, $4, $5, $6)
            `, [tenantId, `tenant-${mode}`, resetAt, employeeId || null, source, JSON.stringify(deleted)]);

            await client.query('COMMIT');

            const totalDeleted = Object.values(deleted).reduce((a, b) => a + b, 0);
            console.log(`[DATA-RESET] ✅ Tenant ${tenantId} (${mode}): ${totalDeleted} registros eliminados\n`);

            res.json({
                success: true,
                message: `${branches.length} sucursales restablecidas (${mode}) — ${totalDeleted} registros eliminados`,
                data: { tenantId, mode, resetAt: resetAt.toISOString(), totalDeleted, deleted, branches: branches.map(b => ({ id: b.id, name: b.name })) }
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
    // ─────────────────────────────────────────────────────────
    router.get('/status/:tenantId', authenticateToken, async (req, res) => {
        try {
            const tenantId = req.user.tenantId;

            // Role check: solo owner o admin pueden ver historial de resets
            const authCheck = await requireOwnerOrAdmin(pool, req.user.employeeId, tenantId);
            if (!authCheck.allowed) {
                return res.status(403).json({ success: false, message: authCheck.reason });
            }

            const resets = await pool.query(`
                SELECT dr.*, b.name as branch_name FROM data_resets dr
                LEFT JOIN branches b ON dr.branch_id = b.id
                WHERE dr.tenant_id = $1 ORDER BY dr.reset_at DESC LIMIT 20
            `, [tenantId]);
            const branches = await pool.query(
                `SELECT id, name, data_reset_at FROM branches WHERE tenant_id = $1 ORDER BY id`, [tenantId]
            );
            res.json({ success: true, data: { branches: branches.rows, resets: resets.rows } });
        } catch (error) {
            res.status(500).json({ success: false, message: 'Error al obtener estado' });
        }
    });

    // ─────────────────────────────────────────────────────────
    // GET /api/data-reset/branch/:branchId/can-delete
    // Pre-check: ¿se puede eliminar esta sucursal?
    // ─────────────────────────────────────────────────────────
    router.get('/branch/:branchId/can-delete', authenticateToken, async (req, res) => {
        try {
            const branchId = parseInt(req.params.branchId);
            const tenantId = req.user.tenantId;

            // Solo owner puede eliminar sucursales
            const ownerCheck = await pool.query(
                'SELECT is_owner FROM employees WHERE id = $1 AND tenant_id = $2 AND is_active = true',
                [req.user.employeeId, tenantId]
            );
            if (!ownerCheck.rows[0]?.is_owner) {
                return res.json({
                    success: true,
                    data: { canDelete: false, reason: 'Solo el propietario puede eliminar sucursales' }
                });
            }

            const branchCheck = await pool.query(
                'SELECT id, name FROM branches WHERE id = $1 AND tenant_id = $2',
                [branchId, tenantId]
            );
            if (branchCheck.rows.length === 0) {
                return res.status(404).json({ success: false, message: 'Sucursal no encontrada' });
            }

            const branchCount = await pool.query(
                'SELECT COUNT(*)::int as count FROM branches WHERE tenant_id = $1',
                [tenantId]
            );

            res.json({
                success: true,
                data: {
                    canDelete: true,
                    branchName: branchCheck.rows[0].name,
                    isLastBranch: branchCount.rows[0].count <= 1,
                    totalBranches: branchCount.rows[0].count
                }
            });
        } catch (error) {
            console.error('[DATA-RESET] ❌ Error en can-delete:', error.message);
            res.status(500).json({ success: false, message: 'Error verificando eliminación' });
        }
    });

    // ─────────────────────────────────────────────────────────
    // DELETE /api/data-reset/branch/:branchId
    // Elimina la sucursal PERMANENTEMENTE (estructura + datos)
    // Solo OWNER puede ejecutar esto
    // ─────────────────────────────────────────────────────────
    router.delete('/branch/:branchId', authenticateToken, async (req, res) => {
        const client = await pool.connect();
        try {
            const branchId = parseInt(req.params.branchId);
            const tenantId = req.user.tenantId;
            const employeeId = req.user.employeeId;

            if (!branchId || !tenantId) {
                client.release();
                return res.status(400).json({ success: false, message: 'branchId y tenantId son requeridos' });
            }

            // OWNER-ONLY (más destructivo que reset)
            const ownerCheck = await pool.query(
                'SELECT is_owner FROM employees WHERE id = $1 AND tenant_id = $2 AND is_active = true',
                [employeeId, tenantId]
            );
            if (!ownerCheck.rows[0]?.is_owner) {
                client.release();
                return res.status(403).json({
                    success: false,
                    message: 'Solo el propietario puede eliminar una sucursal'
                });
            }

            // Verificar que el branch existe y pertenece al tenant
            const branchCheck = await client.query(
                'SELECT id, name FROM branches WHERE id = $1 AND tenant_id = $2',
                [branchId, tenantId]
            );
            if (branchCheck.rows.length === 0) {
                client.release();
                return res.status(404).json({ success: false, message: 'Sucursal no encontrada' });
            }
            const branchName = branchCheck.rows[0].name;

            // Contar branches del tenant
            const branchCount = await client.query(
                'SELECT COUNT(*)::int as count FROM branches WHERE tenant_id = $1',
                [tenantId]
            );
            const isLastBranch = branchCount.rows[0].count <= 1;

            console.log(`\n[DATA-RESET] 🗑️ DELETE BRANCH "${branchName}" (Branch ${branchId}, Tenant ${tenantId}, last=${isLastBranch})`);

            await client.query('BEGIN');

            const resetAt = new Date();

            // Auditoría ANTES del delete (FK se rompería después)
            await client.query(`
                INSERT INTO data_resets (tenant_id, branch_id, reset_scope, reset_at, purge_after, purged_at, requested_by_employee_id, requested_from, records_purged)
                VALUES ($1, $2, 'branch-delete', $3, $3, $3, $4, 'desktop', $5)
            `, [tenantId, isLastBranch ? null : branchId, resetAt, employeeId,
                JSON.stringify({ action: 'delete-branch', branchName, isLastBranch })]);

            // Liberar licencias del branch antes del CASCADE
            await client.query(
                "UPDATE branch_licenses SET status = 'available', branch_id = NULL, updated_at = NOW() WHERE branch_id = $1 AND tenant_id = $2",
                [branchId, tenantId]
            ).catch(() => {}); // Tabla puede no existir

            if (isLastBranch) {
                // Última sucursal → eliminar tenant completo (CASCADE borra branches + todo)
                await client.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
                console.log(`[DATA-RESET] 🗑️ Tenant ${tenantId} eliminado (última sucursal)`);
            } else {
                // Eliminar solo esta sucursal (CASCADE borra datos hijos)
                await client.query('DELETE FROM branches WHERE id = $1 AND tenant_id = $2', [branchId, tenantId]);
                console.log(`[DATA-RESET] 🗑️ Branch ${branchId} eliminado`);
            }

            await client.query('COMMIT');

            res.json({
                success: true,
                message: isLastBranch
                    ? `Sucursal "${branchName}" y todo el negocio eliminados (era la última sucursal)`
                    : `Sucursal "${branchName}" eliminada permanentemente`,
                data: { branchId, branchName, isLastBranch, deletedAt: resetAt.toISOString() }
            });
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            console.error('[DATA-RESET] ❌ Error eliminando sucursal:', error.message);
            res.status(500).json({ success: false, message: 'Error al eliminar sucursal', error: error.message });
        } finally {
            client.release();
        }
    });

    return router;
};
