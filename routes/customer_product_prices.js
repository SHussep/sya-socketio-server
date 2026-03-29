// ═══════════════════════════════════════════════════════════════
// CUSTOMER PRODUCT PRICES - Precios Especiales por Cliente
// Sync + Pull endpoints con idempotencia via global_id
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const { authenticateToken } = require('../middleware/auth');

module.exports = (pool, io) => {
    const router = express.Router();

    // ═══════════════════════════════════════════════════════════
    // POST /sync — Upsert precio especial (idempotente via global_id)
    // ═══════════════════════════════════════════════════════════
    router.post('/sync', authenticateToken, async (req, res) => {
        try {
            const {
                tenant_id,
                customer_global_id,
                product_global_id,
                special_price,
                discount_percentage,
                set_by_employee_global_id,
                set_at,
                notes,
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
            if (!customer_global_id) {
                return res.status(400).json({ success: false, message: 'customer_global_id es requerido' });
            }
            if (!product_global_id) {
                return res.status(400).json({ success: false, message: 'product_global_id es requerido' });
            }

            // Resolver customer_id desde global_id
            const customerRes = await pool.query(
                'SELECT id FROM customers WHERE global_id = $1 AND tenant_id = $2',
                [customer_global_id, tenantId]
            );
            if (customerRes.rows.length === 0) {
                return res.status(404).json({ success: false, message: `Cliente no encontrado: ${customer_global_id}` });
            }
            const customerId = customerRes.rows[0].id;

            // Resolver product_id desde global_id
            const productRes = await pool.query(
                'SELECT id FROM productos WHERE global_id = $1 AND tenant_id = $2',
                [product_global_id, tenantId]
            );
            if (productRes.rows.length === 0) {
                return res.status(404).json({ success: false, message: `Producto no encontrado: ${product_global_id}` });
            }
            const productId = productRes.rows[0].id;

            // Resolver employee_id del que configuró el precio (opcional)
            let setByEmployeeId = null;
            if (set_by_employee_global_id) {
                const empRes = await pool.query(
                    'SELECT id FROM employees WHERE global_id = $1 AND tenant_id = $2',
                    [set_by_employee_global_id, tenantId]
                );
                if (empRes.rows.length > 0) {
                    setByEmployeeId = empRes.rows[0].id;
                }
            }

            const result = await pool.query(
                `INSERT INTO customer_product_prices (
                    tenant_id, customer_id, product_id,
                    special_price, discount_percentage,
                    set_by_employee_id, set_at, notes, is_active,
                    global_id, terminal_id, local_op_seq, created_local_utc, device_event_raw
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
                ON CONFLICT (global_id) DO UPDATE
                SET special_price = EXCLUDED.special_price,
                    discount_percentage = EXCLUDED.discount_percentage,
                    set_by_employee_id = EXCLUDED.set_by_employee_id,
                    set_at = EXCLUDED.set_at,
                    notes = EXCLUDED.notes,
                    is_active = EXCLUDED.is_active,
                    updated_at = NOW()
                RETURNING *`,
                [
                    tenantId, customerId, productId,
                    special_price ?? null, discount_percentage ?? 0,
                    setByEmployeeId, set_at || new Date().toISOString(), notes || null,
                    is_active !== false, // default true
                    global_id, terminal_id || null, local_op_seq || null,
                    created_local_utc || null, device_event_raw || null
                ]
            );

            const row = result.rows[0];
            console.log(`[CustomerProductPrices] ✅ Synced price: customer=${customerId}, product=${productId}, global_id=${global_id}`);

            // Broadcast a todas las sucursales del tenant
            await emitPriceUpdate(pool, io, tenantId, row, 'upsert');

            res.json({
                success: true,
                data: {
                    id: row.id,
                    global_id: row.global_id,
                    customer_id: row.customer_id,
                    product_id: row.product_id,
                    created_at: row.created_at
                }
            });
        } catch (error) {
            console.error('[CustomerProductPrices] ❌ Error en sync:', error.message);

            // Handle unique constraint violation on (tenant_id, customer_id, product_id)
            if (error.code === '23505' && error.constraint?.includes('customer_product_prices_tenant_id_customer_id_product_id')) {
                // Different global_id but same customer+product — update existing record
                try {
                    const { tenant_id, customer_global_id, product_global_id, special_price, discount_percentage,
                            set_by_employee_global_id, set_at, notes, is_active, global_id } = req.body;
                    const tenantId = tenant_id || req.user.tenantId;

                    const updateResult = await pool.query(
                        `UPDATE customer_product_prices
                         SET special_price = $1, discount_percentage = $2,
                             notes = $3, is_active = $4, global_id = $5, updated_at = NOW()
                         WHERE tenant_id = $6
                           AND customer_id = (SELECT id FROM customers WHERE global_id = $7 AND tenant_id = $6)
                           AND product_id = (SELECT id FROM productos WHERE global_id = $8 AND tenant_id = $6)
                         RETURNING *`,
                        [special_price, discount_percentage ?? 0, notes, is_active !== false,
                         global_id, tenantId, customer_global_id, product_global_id]
                    );

                    if (updateResult.rows.length > 0) {
                        return res.json({ success: true, data: updateResult.rows[0] });
                    }
                } catch (innerError) {
                    console.error('[CustomerProductPrices] ❌ Error en fallback update:', innerError.message);
                }
            }

            res.status(500).json({ success: false, message: 'Error sincronizando precio especial' });
        }
    });

    // ═══════════════════════════════════════════════════════════
    // POST /sync-batch — Batch upsert (múltiples precios de un cliente)
    // ═══════════════════════════════════════════════════════════
    router.post('/sync-batch', authenticateToken, async (req, res) => {
        try {
            const { prices } = req.body;
            if (!Array.isArray(prices) || prices.length === 0) {
                return res.status(400).json({ success: false, message: 'Se requiere un array de precios' });
            }

            const results = { synced: 0, failed: 0, errors: [] };

            for (const price of prices) {
                try {
                    // Forward to single sync logic
                    req.body = price;
                    const tenantId = price.tenant_id || req.user.tenantId;

                    if (!price.global_id || !price.customer_global_id || !price.product_global_id) {
                        results.failed++;
                        results.errors.push(`Missing required fields for price: ${price.global_id}`);
                        continue;
                    }

                    // Resolve IDs
                    const customerRes = await pool.query(
                        'SELECT id FROM customers WHERE global_id = $1 AND tenant_id = $2',
                        [price.customer_global_id, tenantId]
                    );
                    const productRes = await pool.query(
                        'SELECT id FROM productos WHERE global_id = $1 AND tenant_id = $2',
                        [price.product_global_id, tenantId]
                    );

                    if (customerRes.rows.length === 0 || productRes.rows.length === 0) {
                        results.failed++;
                        results.errors.push(`Customer or product not found for: ${price.global_id}`);
                        continue;
                    }

                    let setByEmployeeId = null;
                    if (price.set_by_employee_global_id) {
                        const empRes = await pool.query(
                            'SELECT id FROM employees WHERE global_id = $1 AND tenant_id = $2',
                            [price.set_by_employee_global_id, tenantId]
                        );
                        if (empRes.rows.length > 0) setByEmployeeId = empRes.rows[0].id;
                    }

                    await pool.query(
                        `INSERT INTO customer_product_prices (
                            tenant_id, customer_id, product_id,
                            special_price, discount_percentage,
                            set_by_employee_id, set_at, notes, is_active,
                            global_id, terminal_id, local_op_seq, created_local_utc, device_event_raw
                        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
                        ON CONFLICT (global_id) DO UPDATE
                        SET special_price = EXCLUDED.special_price,
                            discount_percentage = EXCLUDED.discount_percentage,
                            set_by_employee_id = EXCLUDED.set_by_employee_id,
                            set_at = EXCLUDED.set_at,
                            notes = EXCLUDED.notes,
                            is_active = EXCLUDED.is_active,
                            updated_at = NOW()`,
                        [
                            tenantId, customerRes.rows[0].id, productRes.rows[0].id,
                            price.special_price ?? null, price.discount_percentage ?? 0,
                            setByEmployeeId, price.set_at || new Date().toISOString(),
                            price.notes || null, price.is_active !== false,
                            price.global_id, price.terminal_id || null,
                            price.local_op_seq || null, price.created_local_utc || null,
                            price.device_event_raw || null
                        ]
                    );
                    results.synced++;
                } catch (err) {
                    results.failed++;
                    results.errors.push(`${price.global_id}: ${err.message}`);
                }
            }

            console.log(`[CustomerProductPrices] 📦 Batch sync: ${results.synced} ok, ${results.failed} failed`);
            res.json({ success: true, data: results });
        } catch (error) {
            console.error('[CustomerProductPrices] ❌ Error en batch sync:', error.message);
            res.status(500).json({ success: false, message: 'Error en batch sync' });
        }
    });

    // ═══════════════════════════════════════════════════════════
    // GET /pull — Descargar precios especiales (incremental con ?since=)
    // ═══════════════════════════════════════════════════════════
    router.get('/pull', authenticateToken, async (req, res) => {
        try {
            const tenantId = req.user.tenantId;
            const { since, customer_id, customer_global_id } = req.query;

            let whereClause = 'WHERE cpp.tenant_id = $1';
            const params = [tenantId];
            let paramIndex = 2;

            // Filtro incremental por fecha
            if (since) {
                whereClause += ` AND cpp.updated_at > $${paramIndex}`;
                params.push(since);
                paramIndex++;
            }

            // Filtro por cliente (opcional, para pull selectivo)
            if (customer_global_id) {
                whereClause += ` AND c.global_id = $${paramIndex}`;
                params.push(customer_global_id);
                paramIndex++;
            } else if (customer_id) {
                whereClause += ` AND cpp.customer_id = $${paramIndex}`;
                params.push(customer_id);
                paramIndex++;
            }

            const result = await pool.query(
                `SELECT
                    cpp.id,
                    cpp.tenant_id,
                    cpp.customer_id,
                    cpp.product_id,
                    cpp.special_price,
                    cpp.discount_percentage,
                    cpp.set_by_employee_id,
                    cpp.set_at,
                    cpp.notes,
                    cpp.is_active,
                    cpp.global_id,
                    cpp.terminal_id,
                    cpp.local_op_seq,
                    cpp.created_local_utc,
                    cpp.created_at,
                    cpp.updated_at,
                    c.global_id AS customer_global_id,
                    c.nombre AS customer_name,
                    p.global_id AS product_global_id,
                    p.descripcion AS product_name,
                    p.precio_venta AS product_base_price,
                    e.global_id AS set_by_employee_global_id,
                    COALESCE(e.first_name || ' ' || COALESCE(e.last_name, ''), 'N/A') AS set_by_employee_name
                FROM customer_product_prices cpp
                JOIN customers c ON cpp.customer_id = c.id
                JOIN productos p ON cpp.product_id = p.id
                LEFT JOIN employees e ON cpp.set_by_employee_id = e.id
                ${whereClause}
                ORDER BY cpp.updated_at ASC`,
                params
            );

            const lastSync = result.rows.length > 0
                ? result.rows[result.rows.length - 1].updated_at
                : since || new Date().toISOString();

            res.json({
                success: true,
                data: {
                    prices: result.rows,
                    last_sync: lastSync
                },
                count: result.rows.length
            });
        } catch (error) {
            console.error('[CustomerProductPrices] ❌ Error en pull:', error.message);
            res.status(500).json({ success: false, message: 'Error obteniendo precios especiales' });
        }
    });

    // ═══════════════════════════════════════════════════════════
    // GET /customer/:customerGlobalId — Precios de un cliente específico
    // ═══════════════════════════════════════════════════════════
    router.get('/customer/:customerGlobalId', authenticateToken, async (req, res) => {
        try {
            const tenantId = req.user.tenantId;
            const { customerGlobalId } = req.params;

            const result = await pool.query(
                `SELECT
                    cpp.id,
                    cpp.special_price,
                    cpp.discount_percentage,
                    cpp.notes,
                    cpp.is_active,
                    cpp.global_id,
                    cpp.set_at,
                    p.global_id AS product_global_id,
                    p.descripcion AS product_name,
                    p.precio_venta AS product_base_price,
                    COALESCE(e.first_name || ' ' || COALESCE(e.last_name, ''), 'N/A') AS set_by_employee_name
                FROM customer_product_prices cpp
                JOIN customers c ON cpp.customer_id = c.id AND c.global_id = $1
                JOIN productos p ON cpp.product_id = p.id
                LEFT JOIN employees e ON cpp.set_by_employee_id = e.id
                WHERE cpp.tenant_id = $2 AND cpp.is_active = TRUE
                ORDER BY p.descripcion ASC`,
                [customerGlobalId, tenantId]
            );

            res.json({
                success: true,
                data: result.rows,
                count: result.rows.length
            });
        } catch (error) {
            console.error('[CustomerProductPrices] ❌ Error:', error.message);
            res.status(500).json({ success: false, message: 'Error obteniendo precios del cliente' });
        }
    });

    return router;
};

// ═══════════════════════════════════════════════════════════════
// Socket.IO broadcast helper
// ═══════════════════════════════════════════════════════════════
async function emitPriceUpdate(pool, io, tenantId, priceData, action) {
    try {
        const branches = await pool.query(
            'SELECT id FROM branches WHERE tenant_id = $1 AND is_active = true',
            [tenantId]
        );
        const payload = { ...priceData, action, updatedAt: new Date() };
        for (const b of branches.rows) {
            io.to(`branch_${b.id}`).emit('customer_product_price_updated', payload);
        }
        console.log(`[CustomerProductPrices] 📡 Emitted to ${branches.rows.length} branches`);
    } catch (error) {
        console.error('[CustomerProductPrices] ⚠️ Error emitting:', error.message);
    }
}
