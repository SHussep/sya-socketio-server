// ═══════════════════════════════════════════════════════════════
// DATA RESET ROUTES
// Opción 1: Restablecer datos (transaccional) — POST /branch/:branchId
// Opción 2: Eliminar negocio (todo) — DELETE /tenant
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { PARTIAL_CLEANUP_TABLES } = require('../utils/cleanupTables');

// Helpers
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
 * Usa mobile_access_type del rol (NO role_id hardcodeado).
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

/**
 * Borra datos transaccionales de un tenant (ventas, turnos, gastos, etc.)
 * Conserva: empleados, clientes, productos, roles, config, estructura
 */
async function deleteTransactionalData(client, tenantId) {
    const deleted = {};

    for (const tableConfig of PARTIAL_CLEANUP_TABLES) {
        const sp = `sp_${tableConfig.name.replace(/[^a-z0-9_]/g, '')}`;
        try {
            await client.query(`SAVEPOINT ${sp}`);

            const exists = await tableExists(client, tableConfig.name);
            if (!exists) {
                await client.query(`RELEASE SAVEPOINT ${sp}`);
                continue;
            }

            let query, params;

            if (tableConfig.customQuery === 'employee_id') {
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

/**
 * Elimina los backups de Dropbox de un tenant (todas las sucursales)
 * Estructura Dropbox: /SYA Backups/{email}/{tenant_id}/...
 */
async function deleteDropboxBackups(pool, tenantId) {
    try {
        // Obtener email del owner para construir la ruta
        const ownerResult = await pool.query(
            `SELECT email FROM employees WHERE tenant_id = $1 AND is_owner = true LIMIT 1`,
            [tenantId]
        );
        if (ownerResult.rows.length === 0 || !ownerResult.rows[0].email) {
            console.log(`[DATA-RESET] ⚠️ No se encontró email del owner, no se pueden borrar backups de Dropbox`);
            return { deleted: false, reason: 'owner-not-found' };
        }

        const email = ownerResult.rows[0].email;
        const sanitizedEmail = email.toLowerCase()
            .replace('@', '_')
            .replace(/[<>:"/\\|?*]/g, '_')
            .replace(/\s+/g, '_')
            .replace(/_+/g, '_')
            .trim();

        const dropboxFolderPath = `/SYA Backups/${sanitizedEmail}/${tenantId}`;

        // Intentar borrar la carpeta completa del tenant (incluye todas las branches)
        const dropboxManager = require('../utils/dropbox-manager');
        await dropboxManager.deleteFile(dropboxFolderPath);

        console.log(`[DATA-RESET] ✅ Backups de Dropbox eliminados: ${dropboxFolderPath}`);
        return { deleted: true, path: dropboxFolderPath };
    } catch (error) {
        // 409 = path not found (no hay backups) — no es error real
        if (error?.status === 409 || error?.error?.['.tag'] === 'path_lookup') {
            console.log(`[DATA-RESET] ℹ️ No había backups en Dropbox para tenant ${tenantId}`);
            return { deleted: false, reason: 'no-backups' };
        }
        console.error(`[DATA-RESET] ⚠️ Error borrando backups de Dropbox: ${error.message}`);
        return { deleted: false, reason: error.message };
    }
}

module.exports = (pool) => {
    const router = express.Router();

    // ─────────────────────────────────────────────────────────
    // POST /api/data-reset/branch/:branchId
    // Restablecer datos transaccionales (ventas, turnos, gastos)
    // Conserva: empleados, clientes, productos, config
    // ─────────────────────────────────────────────────────────
    router.post('/branch/:branchId', authenticateToken, async (req, res) => {
        const client = await pool.connect();
        try {
            const branchId = parseInt(req.params.branchId);
            const tenantId = req.user.tenantId;
            const employeeId = req.body.employeeId;
            const source = req.body.source || 'desktop';

            if (!branchId || !tenantId) {
                client.release();
                return res.status(400).json({ success: false, message: 'branchId y tenantId son requeridos' });
            }

            // Role check: solo owner o admin
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
                client.release();
                return res.status(404).json({ success: false, message: 'Sucursal no encontrada' });
            }

            const branchName = branchCheck.rows[0].name;
            const resetAt = new Date();

            console.log(`\n[DATA-RESET] 🔄 Restablecer datos "${branchName}" (Branch ${branchId}, Tenant ${tenantId})`);

            await client.query('BEGIN');

            const deleted = await deleteTransactionalData(client, tenantId);

            // Resetear settings de branch (multi_caja_enabled, etc.)
            await client.query(
                'UPDATE branches SET multi_caja_enabled = false WHERE id = $1 AND tenant_id = $2',
                [branchId, tenantId]
            );

            await client.query(
                'UPDATE branches SET data_reset_at = $1 WHERE id = $2 AND tenant_id = $3',
                [resetAt, branchId, tenantId]
            );

            await client.query(`
                INSERT INTO data_resets (tenant_id, branch_id, reset_scope, reset_at, purge_after, purged_at, requested_by_employee_id, requested_from, records_purged)
                VALUES ($1, $2, 'reset-data', $3, $3, $3, $4, $5, $6)
            `, [tenantId, branchId, resetAt, employeeId || null, source, JSON.stringify(deleted)]);

            await client.query('COMMIT');

            const totalDeleted = Object.values(deleted).reduce((a, b) => a + b, 0);
            console.log(`[DATA-RESET] ✅ Datos restablecidos: ${totalDeleted} registros eliminados\n`);

            res.json({
                success: true,
                message: `"${branchName}" restablecida — ${totalDeleted} registros eliminados`,
                data: { branchId, branchName, resetAt: resetAt.toISOString(), totalDeleted, deleted }
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
    // DELETE /api/data-reset/tenant
    // ELIMINAR NEGOCIO COMPLETO:
    //   1. Borrar backups de Dropbox
    //   2. DELETE FROM tenants (CASCADE borra todo)
    // Solo OWNER puede ejecutar esto
    // ─────────────────────────────────────────────────────────
    router.delete('/tenant', authenticateToken, async (req, res) => {
        const client = await pool.connect();
        try {
            const tenantId = req.user.tenantId;
            const employeeId = req.user.employeeId;

            if (!tenantId) {
                client.release();
                return res.status(400).json({ success: false, message: 'tenantId es requerido' });
            }

            // OWNER-ONLY
            const ownerCheck = await pool.query(
                'SELECT is_owner FROM employees WHERE id = $1 AND tenant_id = $2 AND is_active = true',
                [employeeId, tenantId]
            );
            if (!ownerCheck.rows[0]?.is_owner) {
                client.release();
                return res.status(403).json({
                    success: false,
                    message: 'Solo el propietario puede eliminar el negocio'
                });
            }

            // Info del tenant para el log
            const tenantInfo = await client.query(
                'SELECT t.business_name, COUNT(b.id)::int as branch_count FROM tenants t LEFT JOIN branches b ON b.tenant_id = t.id WHERE t.id = $1 GROUP BY t.id',
                [tenantId]
            );
            const businessName = tenantInfo.rows[0]?.business_name || `Tenant ${tenantId}`;
            const branchCount = tenantInfo.rows[0]?.branch_count || 0;

            console.log(`\n[DATA-RESET] 🗑️ ELIMINAR NEGOCIO "${businessName}" (Tenant ${tenantId}, ${branchCount} sucursales)`);

            // Paso 1: Borrar backups de Dropbox (antes de borrar el tenant)
            const dropboxResult = await deleteDropboxBackups(pool, tenantId);
            console.log(`[DATA-RESET] Dropbox: ${JSON.stringify(dropboxResult)}`);

            // Paso 2: Borrar tenant de PostgreSQL (CASCADE borra branches, empleados, todo)
            await client.query('BEGIN');

            // Liberar licencias antes del CASCADE
            await client.query(
                "UPDATE branch_licenses SET status = 'available', branch_id = NULL, updated_at = NOW() WHERE tenant_id = $1",
                [tenantId]
            ).catch(() => {});

            // Eliminar registros de data_resets del tenant (evita FK constraint violation)
            await client.query(
                'DELETE FROM data_resets WHERE tenant_id = $1',
                [tenantId]
            ).catch(() => {});

            await client.query('DELETE FROM tenants WHERE id = $1', [tenantId]);

            await client.query('COMMIT');

            console.log(`[DATA-RESET] ✅ Negocio "${businessName}" eliminado completamente\n`);

            res.json({
                success: true,
                message: `"${businessName}" eliminado completamente — ${branchCount} sucursal(es), backups y todos los datos`,
                data: {
                    tenantId,
                    businessName,
                    branchCount,
                    dropbox: dropboxResult,
                    deletedAt: new Date().toISOString()
                }
            });
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            console.error('[DATA-RESET] ❌ Error eliminando negocio:', error.message);
            res.status(500).json({ success: false, message: 'Error al eliminar negocio', error: error.message });
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

    return router;
};
