// ═══════════════════════════════════════════════════════════════
// PRODUCTO BRANCHES - Productos asignados por sucursal
// Sync + Pull endpoints con idempotencia via global_id
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const { authenticateToken } = require('../middleware/auth');

module.exports = (pool, io) => {
    const router = express.Router();

    // ═══════════════════════════════════════════════════════════
    // POST /sync — Upsert producto-branch (idempotente via global_id)
    // ═══════════════════════════════════════════════════════════
    router.post('/sync', authenticateToken, async (req, res) => {
        try {
            const {
                tenant_id,
                product_global_id,
                branch_id,
                precio_venta,
                precio_compra,
                inventario,
                minimo,
                is_active,
                // Offline-first
                global_id,
                terminal_id,
                local_op_seq,
                created_local_utc,
                device_event_raw
            } = req.body;

            const tenantId = tenant_id || req.user.tenantId;

            if (!global_id) {
                return res.status(400).json({ success: false, message: 'global_id es requerido' });
            }
            if (!product_global_id) {
                return res.status(400).json({ success: false, message: 'product_global_id es requerido' });
            }
            if (!branch_id) {
                return res.status(400).json({ success: false, message: 'branch_id es requerido' });
            }

            // Verificar que el producto existe
            const productRes = await pool.query(
                'SELECT id FROM productos WHERE global_id = $1 AND tenant_id = $2',
                [product_global_id, tenantId]
            );
            if (productRes.rows.length === 0) {
                return res.status(404).json({ success: false, message: `Producto no encontrado: ${product_global_id}` });
            }

            const result = await pool.query(
                `INSERT INTO producto_branches (
                    tenant_id, branch_id, product_global_id,
                    precio_venta, precio_compra, inventario, minimo, is_active,
                    global_id, terminal_id, local_op_seq, created_local_utc, device_event_raw
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
                ON CONFLICT (global_id) DO UPDATE
                SET precio_venta = EXCLUDED.precio_venta,
                    precio_compra = EXCLUDED.precio_compra,
                    inventario = EXCLUDED.inventario,
                    minimo = EXCLUDED.minimo,
                    is_active = EXCLUDED.is_active,
                    updated_at = NOW()
                RETURNING *`,
                [
                    tenantId, branch_id, product_global_id,
                    precio_venta ?? 0, precio_compra ?? 0,
                    inventario ?? 0, minimo ?? 0,
                    is_active !== false, // default true
                    global_id, terminal_id || null, local_op_seq || null,
                    created_local_utc || null, device_event_raw || null
                ]
            );

            const row = result.rows[0];
            console.log(`[ProductoBranch] Synced: branch=${branch_id}, product=${product_global_id}, global_id=${global_id}`);

            // Broadcast al tenant para que otras sucursales se enteren
            const tenantRoom = `tenant_${tenantId}`;
            io.to(tenantRoom).emit('producto_branch:updated', {
                ...row,
                action: 'upsert',
                updatedAt: new Date()
            });

            res.json({
                success: true,
                data: {
                    id: row.id,
                    global_id: row.global_id
                }
            });
        } catch (error) {
            console.error('[ProductoBranch] Error en sync:', error.message);

            // Handle unique constraint violation on (tenant_id, product_global_id, branch_id)
            if (error.code === '23505' && error.constraint?.includes('producto_branches_tenant_id_product_global_id_branch_id')) {
                try {
                    const { tenant_id, product_global_id, branch_id, precio_venta, precio_compra,
                            inventario, minimo, is_active, global_id } = req.body;
                    const tenantId = tenant_id || req.user.tenantId;

                    const updateResult = await pool.query(
                        `UPDATE producto_branches
                         SET precio_venta = $1, precio_compra = $2,
                             inventario = $3, minimo = $4,
                             is_active = $5, global_id = $6, updated_at = NOW()
                         WHERE tenant_id = $7
                           AND product_global_id = $8
                           AND branch_id = $9
                         RETURNING *`,
                        [precio_venta ?? 0, precio_compra ?? 0,
                         inventario ?? 0, minimo ?? 0,
                         is_active !== false, global_id,
                         tenantId, product_global_id, branch_id]
                    );

                    if (updateResult.rows.length > 0) {
                        return res.json({ success: true, data: updateResult.rows[0] });
                    }
                } catch (innerError) {
                    console.error('[ProductoBranch] Error en fallback update:', innerError.message);
                }
            }

            res.status(500).json({ success: false, message: 'Error sincronizando producto-branch' });
        }
    });

    // ═══════════════════════════════════════════════════════════
    // POST /sync-batch — Batch upsert (multiple producto-branches)
    // ═══════════════════════════════════════════════════════════
    router.post('/sync-batch', authenticateToken, async (req, res) => {
        try {
            const { items } = req.body;
            if (!Array.isArray(items) || items.length === 0) {
                return res.status(400).json({ success: false, message: 'Se requiere un array de items' });
            }

            const results = { synced: 0, failed: 0, errors: [] };
            const tenantId = req.user.tenantId;

            for (const item of items) {
                try {
                    if (!item.global_id || !item.product_global_id || !item.branch_id) {
                        results.failed++;
                        results.errors.push(`Missing required fields for: ${item.global_id}`);
                        continue;
                    }

                    const itemTenantId = item.tenant_id || tenantId;

                    // Verificar que el producto existe
                    const productRes = await pool.query(
                        'SELECT id FROM productos WHERE global_id = $1 AND tenant_id = $2',
                        [item.product_global_id, itemTenantId]
                    );
                    if (productRes.rows.length === 0) {
                        results.failed++;
                        results.errors.push(`Product not found: ${item.product_global_id}`);
                        continue;
                    }

                    await pool.query(
                        `INSERT INTO producto_branches (
                            tenant_id, branch_id, product_global_id,
                            precio_venta, precio_compra, inventario, minimo, is_active,
                            global_id, terminal_id, local_op_seq, created_local_utc, device_event_raw
                        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
                        ON CONFLICT (global_id) DO UPDATE
                        SET precio_venta = EXCLUDED.precio_venta,
                            precio_compra = EXCLUDED.precio_compra,
                            inventario = EXCLUDED.inventario,
                            minimo = EXCLUDED.minimo,
                            is_active = EXCLUDED.is_active,
                            updated_at = NOW()`,
                        [
                            itemTenantId, item.branch_id, item.product_global_id,
                            item.precio_venta ?? 0, item.precio_compra ?? 0,
                            item.inventario ?? 0, item.minimo ?? 0,
                            item.is_active !== false,
                            item.global_id, item.terminal_id || null,
                            item.local_op_seq || null, item.created_local_utc || null,
                            item.device_event_raw || null
                        ]
                    );
                    results.synced++;
                } catch (err) {
                    results.failed++;
                    results.errors.push(`${item.global_id}: ${err.message}`);
                }
            }

            console.log(`[ProductoBranch] Batch sync: ${results.synced} ok, ${results.failed} failed`);
            res.json({ success: true, data: results });
        } catch (error) {
            console.error('[ProductoBranch] Error en batch sync:', error.message);
            res.status(500).json({ success: false, message: 'Error en batch sync' });
        }
    });

    // ═══════════════════════════════════════════════════════════
    // GET /pull — Descargar producto-branches (incremental con ?since=)
    // ═══════════════════════════════════════════════════════════
    router.get('/pull', authenticateToken, async (req, res) => {
        try {
            const tenantId = req.user.tenantId;
            const { branchId, since } = req.query;

            let whereClause = 'WHERE pb.tenant_id = $1';
            const params = [tenantId];
            let paramIndex = 2;

            // Filtro por sucursal
            if (branchId) {
                whereClause += ` AND pb.branch_id = $${paramIndex}`;
                params.push(parseInt(branchId));
                paramIndex++;
            }

            // Filtro incremental por fecha
            if (since) {
                whereClause += ` AND pb.updated_at > $${paramIndex}`;
                params.push(since);
                paramIndex++;
            }

            const result = await pool.query(
                `SELECT
                    pb.id,
                    pb.tenant_id,
                    pb.branch_id,
                    pb.product_global_id,
                    pb.precio_venta,
                    pb.precio_compra,
                    pb.inventario,
                    pb.minimo,
                    pb.is_active,
                    pb.assigned_at,
                    pb.global_id,
                    pb.terminal_id,
                    pb.local_op_seq,
                    pb.created_local_utc,
                    pb.created_at,
                    pb.updated_at,
                    p.descripcion AS product_name,
                    p.unidad_medida AS product_unit
                FROM producto_branches pb
                JOIN productos p ON p.global_id = pb.product_global_id AND p.tenant_id = pb.tenant_id
                ${whereClause}
                ORDER BY pb.updated_at ASC`,
                params
            );

            const lastSync = result.rows.length > 0
                ? result.rows[result.rows.length - 1].updated_at
                : since || new Date().toISOString();

            res.json({
                success: true,
                data: {
                    items: result.rows,
                    last_sync: lastSync
                },
                count: result.rows.length
            });
        } catch (error) {
            console.error('[ProductoBranch] Error en pull:', error.message);
            res.status(500).json({ success: false, message: 'Error obteniendo producto-branches' });
        }
    });

    return router;
};
