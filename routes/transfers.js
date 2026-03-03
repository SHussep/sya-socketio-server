// ═══════════════════════════════════════════════════════════════
// TRANSFERS ROUTES - Inter-branch inventory transfers
// Atomic transactions: deduct from source, add to target
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { sendNotificationToAdminsInBranch } = require('../utils/notificationHelper');

module.exports = (pool, io) => {
    const router = express.Router();

    // ═══════════════════════════════════════════════════════════
    // POST /api/transfers — Create transfer (atomic transaction)
    // ═══════════════════════════════════════════════════════════
    router.post('/', async (req, res) => {
        const client = await pool.connect();

        try {
            const {
                tenant_id: tenantId,
                employee_id: rawEmployeeId,
                employee_global_id: employeeGlobalId,
                from_branch_id,
                to_branch_id,
                global_id,
                terminal_id,
                notes,
                items
            } = req.body;

            if (!tenantId) {
                return res.status(400).json({
                    success: false,
                    message: 'tenant_id es requerido'
                });
            }

            // Resolve employee_id: accept direct ID or resolve from global_id
            let employeeId = rawEmployeeId;
            if (!employeeId && employeeGlobalId) {
                const empLookup = await client.query(
                    `SELECT id FROM employees WHERE global_id = $1 AND tenant_id = $2`,
                    [employeeGlobalId, tenantId]
                );
                if (empLookup.rows.length > 0) {
                    employeeId = empLookup.rows[0].id;
                }
            }

            if (!employeeId) {
                return res.status(400).json({
                    success: false,
                    message: 'employee_id o employee_global_id es requerido'
                });
            }

            console.log(`[Transfers/POST] 📦 Transferencia solicitada: branch ${from_branch_id} → ${to_branch_id} (${items?.length || 0} items)`);

            // ── Validaciones ──────────────────────────────────
            if (!from_branch_id || !to_branch_id || !items || items.length === 0) {
                return res.status(400).json({
                    success: false,
                    message: 'from_branch_id, to_branch_id y items son requeridos'
                });
            }

            if (from_branch_id === to_branch_id) {
                return res.status(400).json({
                    success: false,
                    message: 'No se puede transferir a la misma sucursal'
                });
            }

            // Verify both branches belong to same tenant
            const branchCheck = await client.query(
                `SELECT id, name FROM branches
                 WHERE id IN ($1, $2) AND tenant_id = $3`,
                [from_branch_id, to_branch_id, tenantId]
            );

            if (branchCheck.rows.length !== 2) {
                return res.status(400).json({
                    success: false,
                    message: 'Una o ambas sucursales no pertenecen a este tenant'
                });
            }

            const fromBranch = branchCheck.rows.find(b => b.id === from_branch_id);
            const toBranch = branchCheck.rows.find(b => b.id === to_branch_id);

            // Verify permission: CanTransferInventory
            const permCheck = await client.query(
                `SELECT 1 FROM employees e
                 JOIN roles r ON e.role_id = r.id
                 JOIN role_permissions rp ON rp.role_id = r.id
                 JOIN permissions p ON p.id = rp.permission_id
                 WHERE e.id = $1 AND p.code = 'CanTransferInventory'`,
                [employeeId]
            );

            if (permCheck.rows.length === 0) {
                return res.status(403).json({
                    success: false,
                    message: 'No tiene permiso para transferir inventario (CanTransferInventory)'
                });
            }

            // Get employee name for notifications
            const empResult = await client.query(
                `SELECT first_name, last_name FROM employees WHERE id = $1`,
                [employeeId]
            );
            const employeeName = empResult.rows[0]
                ? `${empResult.rows[0].first_name} ${empResult.rows[0].last_name}`.trim()
                : 'Empleado';

            // ── Transaction ───────────────────────────────────
            await client.query('BEGIN');

            const transferGlobalId = global_id || uuidv4();
            const processedItems = [];

            for (const item of items) {
                const { producto_global_id, quantity } = item;

                if (!producto_global_id || !quantity || quantity <= 0) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({
                        success: false,
                        message: `Item inválido: producto_global_id y quantity > 0 requeridos`
                    });
                }

                // Resolve producto_id from global_id
                const prodResult = await client.query(
                    `SELECT id, descripcion, unidad_medida_id
                     FROM productos
                     WHERE global_id = $1 AND tenant_id = $2 AND eliminado = FALSE`,
                    [producto_global_id, tenantId]
                );

                if (prodResult.rows.length === 0) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({
                        success: false,
                        message: `Producto no encontrado: ${producto_global_id}`
                    });
                }

                const product = prodResult.rows[0];

                // Get unit abbreviation
                const unitResult = await client.query(
                    `SELECT abbreviation FROM units_of_measure WHERE id = $1`,
                    [product.unidad_medida_id]
                );
                const unitAbbrev = unitResult.rows[0]?.abbreviation || 'kg';

                // Lock source row and check stock
                const sourceStock = await client.query(
                    `SELECT quantity FROM branch_inventory
                     WHERE branch_id = $1 AND producto_id = $2 AND tenant_id = $3
                     FOR UPDATE`,
                    [from_branch_id, product.id, tenantId]
                );

                const stockBeforeSource = parseFloat(sourceStock.rows[0]?.quantity || 0);

                // Get target stock before transfer
                const targetStock = await client.query(
                    `SELECT quantity FROM branch_inventory
                     WHERE branch_id = $1 AND producto_id = $2 AND tenant_id = $3
                     FOR UPDATE`,
                    [to_branch_id, product.id, tenantId]
                );
                const stockBeforeTarget = parseFloat(targetStock.rows[0]?.quantity || 0);

                if (stockBeforeSource < quantity) {
                    console.log(`[Transfers/POST]   ⚠️ Stock insuficiente de "${product.descripcion}": disponible ${stockBeforeSource}, solicitado ${quantity} — se permite de todas formas`);
                }

                // Deduct from source (upsert: create row if not exists, then subtract)
                if (sourceStock.rows.length === 0) {
                    await client.query(
                        `INSERT INTO branch_inventory (tenant_id, branch_id, producto_id, quantity, minimum)
                         VALUES ($1, $2, $3, (0 - $4::numeric), 0)
                         ON CONFLICT (tenant_id, branch_id, producto_id)
                         DO UPDATE SET quantity = branch_inventory.quantity - $4::numeric, updated_at = NOW()`,
                        [tenantId, from_branch_id, product.id, quantity]
                    );
                } else {
                    await client.query(
                        `UPDATE branch_inventory
                         SET quantity = quantity - $1::numeric, updated_at = NOW()
                         WHERE branch_id = $2 AND producto_id = $3 AND tenant_id = $4`,
                        [quantity, from_branch_id, product.id, tenantId]
                    );
                }

                // Add to target (upsert)
                await client.query(
                    `INSERT INTO branch_inventory (tenant_id, branch_id, producto_id, quantity, minimum)
                     VALUES ($1, $2, $3, $4, 0)
                     ON CONFLICT (tenant_id, branch_id, producto_id)
                     DO UPDATE SET quantity = branch_inventory.quantity + $4, updated_at = NOW()`,
                    [tenantId, to_branch_id, product.id, quantity]
                );

                const stockAfterSource = stockBeforeSource - parseFloat(quantity);
                const stockAfterTarget = stockBeforeTarget + parseFloat(quantity);

                processedItems.push({
                    producto_id: product.id,
                    producto_global_id,
                    product_name: product.descripcion,
                    quantity: parseFloat(quantity),
                    unit_abbreviation: unitAbbrev,
                    stock_before_source: stockBeforeSource,
                    stock_after_source: stockAfterSource,
                    stock_before_target: stockBeforeTarget,
                    stock_after_target: stockAfterTarget,
                    stock_warning: stockBeforeSource < quantity
                        ? `Stock insuficiente: disponible ${stockBeforeSource}, transferido ${quantity}`
                        : null
                });

                console.log(`[Transfers/POST]   📦 ${product.descripcion}: -${quantity}${unitAbbrev} (branch ${from_branch_id}) → +${quantity}${unitAbbrev} (branch ${to_branch_id})`);
            }

            // Insert transfer record
            const transferResult = await client.query(
                `INSERT INTO inventory_transfers
                 (tenant_id, from_branch_id, to_branch_id, status, notes, created_by_employee_id, global_id, terminal_id)
                 VALUES ($1, $2, $3, 'completed', $4, $5, $6, $7)
                 RETURNING id, created_at`,
                [tenantId, from_branch_id, to_branch_id, notes || null, employeeId, transferGlobalId, terminal_id || null]
            );

            const transfer = transferResult.rows[0];

            // Insert transfer items (with before/after stock tracking)
            for (const item of processedItems) {
                await client.query(
                    `INSERT INTO inventory_transfer_items
                     (transfer_id, producto_id, quantity, product_name, unit_abbreviation,
                      stock_before_source, stock_after_source, stock_before_target, stock_after_target)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                    [transfer.id, item.producto_id, item.quantity, item.product_name, item.unit_abbreviation,
                     item.stock_before_source, item.stock_after_source, item.stock_before_target, item.stock_after_target]
                );
            }

            await client.query('COMMIT');

            console.log(`[Transfers/POST] ✅ Transferencia #${transfer.id} completada (${processedItems.length} items)`);

            // ── Notifications ─────────────────────────────────

            const transferPayload = {
                transferId: transfer.id,
                globalId: transferGlobalId,
                fromBranchId: from_branch_id,
                fromBranchName: fromBranch?.name || `Sucursal ${from_branch_id}`,
                toBranchId: to_branch_id,
                toBranchName: toBranch?.name || `Sucursal ${to_branch_id}`,
                createdByName: employeeName,
                createdByEmployeeId: employeeId,
                notes: notes || '',
                items: processedItems,
                createdAt: transfer.created_at,
                receivedAt: new Date().toISOString()
            };

            // Socket.IO: notify target branch
            io.to(`branch_${to_branch_id}`).emit('transfer:received', transferPayload);
            console.log(`[Transfers/POST] 📡 Socket transfer:received → branch_${to_branch_id}`);

            // Socket.IO: confirm to source branch
            io.to(`branch_${from_branch_id}`).emit('transfer:sent', transferPayload);

            // FCM: push to admins in target branch
            try {
                const itemsSummary = processedItems.length === 1
                    ? `${processedItems[0].product_name} (${processedItems[0].quantity} ${processedItems[0].unit_abbreviation})`
                    : `${processedItems.length} productos`;

                await sendNotificationToAdminsInBranch(to_branch_id, {
                    title: 'Transferencia recibida',
                    body: `${itemsSummary} desde ${fromBranch?.name || 'otra sucursal'} — por ${employeeName}`,
                    data: {
                        type: 'transfer_received',
                        transferId: String(transfer.id),
                        fromBranchId: String(from_branch_id),
                        fromBranchName: fromBranch?.name || ''
                    }
                });
                console.log(`[Transfers/POST] 📲 FCM enviado a admins de branch_${to_branch_id}`);
            } catch (fcmErr) {
                console.error(`[Transfers/POST] ⚠️ FCM error (no-critical): ${fcmErr.message}`);
            }

            return res.status(201).json({
                success: true,
                message: 'Transferencia completada exitosamente',
                data: {
                    id: transfer.id,
                    global_id: transferGlobalId,
                    from_branch_id,
                    to_branch_id,
                    status: 'completed',
                    items: processedItems,
                    created_at: transfer.created_at
                }
            });

        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            console.error(`[Transfers/POST] ❌ Error: ${error.message}`);
            return res.status(500).json({
                success: false,
                message: 'Error al crear transferencia',
                error: error.message
            });
        } finally {
            client.release();
        }
    });

    // ═══════════════════════════════════════════════════════════
    // GET /api/transfers — List transfers for a branch
    // ═══════════════════════════════════════════════════════════
    router.get('/', async (req, res) => {
        try {
            const tenantId = parseInt(req.query.tenant_id);
            const branchId = parseInt(req.query.branch_id) || null;

            if (!tenantId) {
                return res.status(400).json({ success: false, message: 'tenant_id es requerido' });
            }
            const direction = req.query.direction || 'all'; // incoming, outgoing, all
            const from = req.query.from;
            const to = req.query.to;
            const limit = Math.min(parseInt(req.query.limit) || 50, 200);
            const offset = parseInt(req.query.offset) || 0;

            let whereConditions = ['t.tenant_id = $1'];
            let params = [tenantId];
            let paramIdx = 2;

            if (branchId) {
                if (direction === 'incoming') {
                    whereConditions.push(`t.to_branch_id = $${paramIdx}`);
                } else if (direction === 'outgoing') {
                    whereConditions.push(`t.from_branch_id = $${paramIdx}`);
                } else {
                    whereConditions.push(`(t.from_branch_id = $${paramIdx} OR t.to_branch_id = $${paramIdx})`);
                }
                params.push(branchId);
                paramIdx++;
            }

            if (from) {
                whereConditions.push(`t.created_at >= $${paramIdx}::timestamptz`);
                params.push(from);
                paramIdx++;
            }
            if (to) {
                whereConditions.push(`t.created_at <= $${paramIdx}::timestamptz`);
                params.push(to);
                paramIdx++;
            }

            const whereClause = whereConditions.join(' AND ');

            const result = await pool.query(
                `SELECT t.id, t.from_branch_id, t.to_branch_id, t.status, t.notes,
                        t.global_id, t.created_at,
                        t.created_by_employee_id,
                        fb.name AS from_branch_name,
                        tb.name AS to_branch_name,
                        CONCAT(e.first_name, ' ', e.last_name) AS created_by_name
                 FROM inventory_transfers t
                 JOIN branches fb ON fb.id = t.from_branch_id
                 JOIN branches tb ON tb.id = t.to_branch_id
                 JOIN employees e ON e.id = t.created_by_employee_id
                 WHERE ${whereClause}
                 ORDER BY t.created_at DESC
                 LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
                [...params, limit, offset]
            );

            // Fetch items for each transfer
            const transfers = [];
            for (const row of result.rows) {
                const itemsResult = await pool.query(
                    `SELECT ti.producto_id, ti.product_name, ti.quantity, ti.unit_abbreviation,
                            ti.stock_before_source, ti.stock_after_source,
                            ti.stock_before_target, ti.stock_after_target
                     FROM inventory_transfer_items ti
                     WHERE ti.transfer_id = $1
                     ORDER BY ti.id`,
                    [row.id]
                );

                transfers.push({
                    ...row,
                    items: itemsResult.rows
                });
            }

            return res.json({
                success: true,
                data: transfers,
                pagination: { limit, offset, count: transfers.length }
            });

        } catch (error) {
            console.error(`[Transfers/GET] ❌ Error: ${error.message}`);
            return res.status(500).json({ success: false, message: error.message });
        }
    });

    // ═══════════════════════════════════════════════════════════
    // GET /api/transfers/tenant-branches — Branches for tenant
    // (Used by Desktop to populate target branch selector)
    // ═══════════════════════════════════════════════════════════
    router.get('/tenant-branches', async (req, res) => {
        try {
            const tenantId = parseInt(req.query.tenant_id);

            if (!tenantId) {
                return res.status(400).json({ success: false, message: 'tenant_id es requerido' });
            }

            const result = await pool.query(
                `SELECT id, name, branch_code, is_active
                 FROM branches
                 WHERE tenant_id = $1 AND is_active = TRUE
                 ORDER BY created_at ASC`,
                [tenantId]
            );

            return res.json({
                success: true,
                data: result.rows
            });

        } catch (error) {
            console.error(`[Transfers/TenantBranches] ❌ Error: ${error.message}`);
            return res.status(500).json({ success: false, message: error.message });
        }
    });

    // ═══════════════════════════════════════════════════════════
    // GET /api/transfers/:id — Transfer detail
    // ═══════════════════════════════════════════════════════════
    router.get('/:id', async (req, res) => {
        try {
            const tenantId = parseInt(req.query.tenant_id);

            if (!tenantId) {
                return res.status(400).json({ success: false, message: 'tenant_id es requerido' });
            }
            const transferId = req.params.id;

            const result = await pool.query(
                `SELECT t.*,
                        fb.name AS from_branch_name,
                        tb.name AS to_branch_name,
                        CONCAT(e.first_name, ' ', e.last_name) AS created_by_name,
                        CONCAT(ce.first_name, ' ', ce.last_name) AS cancelled_by_name
                 FROM inventory_transfers t
                 JOIN branches fb ON fb.id = t.from_branch_id
                 JOIN branches tb ON tb.id = t.to_branch_id
                 JOIN employees e ON e.id = t.created_by_employee_id
                 LEFT JOIN employees ce ON ce.id = t.cancelled_by_employee_id
                 WHERE t.id = $1 AND t.tenant_id = $2`,
                [transferId, tenantId]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({ success: false, message: 'Transferencia no encontrada' });
            }

            const itemsResult = await pool.query(
                `SELECT ti.producto_id, ti.product_name, ti.quantity, ti.unit_abbreviation,
                        p.global_id AS producto_global_id
                 FROM inventory_transfer_items ti
                 JOIN productos p ON p.id = ti.producto_id
                 WHERE ti.transfer_id = $1
                 ORDER BY ti.id`,
                [transferId]
            );

            return res.json({
                success: true,
                data: {
                    ...result.rows[0],
                    items: itemsResult.rows
                }
            });

        } catch (error) {
            console.error(`[Transfers/GET/:id] ❌ Error: ${error.message}`);
            return res.status(500).json({ success: false, message: error.message });
        }
    });

    // ═══════════════════════════════════════════════════════════
    // POST /api/transfers/:id/cancel — Cancel/reverse transfer
    // ═══════════════════════════════════════════════════════════
    router.post('/:id/cancel', async (req, res) => {
        const client = await pool.connect();

        try {
            const transferId = req.params.id;
            const { tenant_id: tenantId, employee_id: rawEmployeeId, employee_global_id: employeeGlobalId, reason } = req.body;

            if (!tenantId) {
                return res.status(400).json({
                    success: false,
                    message: 'tenant_id es requerido'
                });
            }

            // Resolve employee_id from global_id if needed
            let employeeId = rawEmployeeId;
            if (!employeeId && employeeGlobalId) {
                const empLookup = await client.query(
                    `SELECT id FROM employees WHERE global_id = $1 AND tenant_id = $2`,
                    [employeeGlobalId, tenantId]
                );
                if (empLookup.rows.length > 0) {
                    employeeId = empLookup.rows[0].id;
                }
            }

            if (!employeeId) {
                return res.status(400).json({
                    success: false,
                    message: 'employee_id o employee_global_id es requerido'
                });
            }

            if (!reason || reason.trim().length < 3) {
                return res.status(400).json({
                    success: false,
                    message: 'Se requiere una razón de cancelación (mínimo 3 caracteres)'
                });
            }

            // Verify transfer exists and is completed
            const transferResult = await client.query(
                `SELECT t.*, fb.name AS from_branch_name, tb.name AS to_branch_name
                 FROM inventory_transfers t
                 JOIN branches fb ON fb.id = t.from_branch_id
                 JOIN branches tb ON tb.id = t.to_branch_id
                 WHERE t.id = $1 AND t.tenant_id = $2`,
                [transferId, tenantId]
            );

            if (transferResult.rows.length === 0) {
                return res.status(404).json({ success: false, message: 'Transferencia no encontrada' });
            }

            const transfer = transferResult.rows[0];

            if (transfer.status !== 'completed') {
                return res.status(400).json({
                    success: false,
                    message: `No se puede cancelar: estado actual es "${transfer.status}"`
                });
            }

            // Get items
            const itemsResult = await client.query(
                `SELECT ti.producto_id, ti.quantity, ti.product_name, ti.unit_abbreviation
                 FROM inventory_transfer_items ti
                 WHERE ti.transfer_id = $1`,
                [transferId]
            );

            console.log(`[Transfers/CANCEL] 🔄 Cancelando transferencia #${transferId} (${itemsResult.rows.length} items)`);

            await client.query('BEGIN');

            // Reverse inventory for each item
            for (const item of itemsResult.rows) {
                // Add back to source (was deducted)
                await client.query(
                    `UPDATE branch_inventory
                     SET quantity = quantity + $1, updated_at = NOW()
                     WHERE branch_id = $2 AND producto_id = $3 AND tenant_id = $4`,
                    [item.quantity, transfer.from_branch_id, item.producto_id, tenantId]
                );

                // Deduct from target (was added)
                await client.query(
                    `UPDATE branch_inventory
                     SET quantity = GREATEST(0, quantity - $1), updated_at = NOW()
                     WHERE branch_id = $2 AND producto_id = $3 AND tenant_id = $4`,
                    [item.quantity, transfer.to_branch_id, item.producto_id, tenantId]
                );

                console.log(`[Transfers/CANCEL]   ↩️ ${item.product_name}: +${item.quantity} → branch ${transfer.from_branch_id}, -${item.quantity} → branch ${transfer.to_branch_id}`);
            }

            // Update transfer status
            await client.query(
                `UPDATE inventory_transfers
                 SET status = 'cancelled',
                     cancelled_by_employee_id = $1,
                     cancelled_at = NOW(),
                     cancellation_reason = $2
                 WHERE id = $3`,
                [employeeId, reason.trim(), transferId]
            );

            await client.query('COMMIT');

            console.log(`[Transfers/CANCEL] ✅ Transferencia #${transferId} cancelada`);

            // Notify both branches
            const cancelPayload = {
                transferId: transfer.id,
                globalId: transfer.global_id,
                fromBranchId: transfer.from_branch_id,
                fromBranchName: transfer.from_branch_name,
                toBranchId: transfer.to_branch_id,
                toBranchName: transfer.to_branch_name,
                reason: reason.trim(),
                cancelledAt: new Date().toISOString()
            };

            io.to(`branch_${transfer.from_branch_id}`).emit('transfer:cancelled', cancelPayload);
            io.to(`branch_${transfer.to_branch_id}`).emit('transfer:cancelled', cancelPayload);

            return res.json({
                success: true,
                message: 'Transferencia cancelada y revertida exitosamente'
            });

        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            console.error(`[Transfers/CANCEL] ❌ Error: ${error.message}`);
            return res.status(500).json({ success: false, message: error.message });
        } finally {
            client.release();
        }
    });

    // ═══════════════════════════════════════════════════════════
    // GET /api/transfers/branch-inventory — Get branch inventory
    // ═══════════════════════════════════════════════════════════
    router.get('/branch-inventory/:branch_id', async (req, res) => {
        try {
            const tenantId = parseInt(req.query.tenant_id);

            if (!tenantId) {
                return res.status(400).json({ success: false, message: 'tenant_id es requerido' });
            }
            const branchId = req.params.branch_id;

            const result = await pool.query(
                `SELECT bi.producto_id, bi.quantity, bi.minimum, bi.updated_at,
                        p.descripcion AS product_name, p.global_id AS producto_global_id,
                        p.bascula, p.inventariar,
                        um.abreviacion AS unit_abbreviation
                 FROM branch_inventory bi
                 JOIN productos p ON p.id = bi.producto_id
                 LEFT JOIN units_of_measure um ON um.id = p.unidad_medida_id
                 WHERE bi.branch_id = $1 AND bi.tenant_id = $2 AND p.eliminado = FALSE
                 ORDER BY p.descripcion`,
                [branchId, tenantId]
            );

            return res.json({
                success: true,
                data: result.rows
            });

        } catch (error) {
            console.error(`[Transfers/BranchInventory] ❌ Error: ${error.message}`);
            return res.status(500).json({ success: false, message: error.message });
        }
    });

    return router;
};
