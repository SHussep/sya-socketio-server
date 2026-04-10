// ═══════════════════════════════════════════════════════════════
// KARDEX ROUTES - Registro de movimientos de inventario
// ═══════════════════════════════════════════════════════════════
// Sincronización server-first desde Desktop/Mobile
// Cada movimiento de inventario se registra para trazabilidad
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET;

function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ success: false, message: 'Token requerido' });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ success: false, message: 'Token inválido' });
        req.user = user;
        next();
    });
}

module.exports = (pool) => {
    const router = express.Router();
    router.use(authenticateToken);

    // ═══════════════════════════════════════════════════════════════
    // POST /api/kardex/sync - Sincronizar entrada(s) de kardex
    // Soporta un solo entry o un array (bulk sync)
    // IDEMPOTENTE: Usa global_id para ON CONFLICT
    // ═══════════════════════════════════════════════════════════════
    router.post('/sync', async (req, res) => {
        try {
            const entries = Array.isArray(req.body) ? req.body : [req.body];
            const results = [];

            for (const entry of entries) {
                const {
                    tenant_id,
                    branch_id,
                    product_id,
                    product_global_id,
                    timestamp,
                    movement_type,
                    employee_id,
                    employee_global_id,
                    quantity_before,
                    quantity_change,
                    quantity_after,
                    description,
                    sale_id,
                    purchase_id,
                    adjustment_id,
                    global_id,
                    terminal_id,
                    source
                } = entry;

                if (!tenant_id || !global_id || !movement_type) {
                    results.push({ global_id, success: false, message: 'Datos incompletos (tenant_id, global_id, movement_type requeridos)' });
                    continue;
                }

                // Resolver product_id desde product_global_id si no viene el ID directo
                let resolvedProductId = product_id || null;
                if (!resolvedProductId && product_global_id) {
                    const prodResult = await pool.query(
                        'SELECT id FROM productos WHERE global_id = $1 AND tenant_id = $2',
                        [product_global_id, tenant_id]
                    );
                    if (prodResult.rows.length > 0) {
                        resolvedProductId = prodResult.rows[0].id;
                    }
                }

                // Resolver employee_id desde employee_global_id si no viene
                let resolvedEmployeeId = employee_id || null;
                if (!resolvedEmployeeId && employee_global_id) {
                    const empResult = await pool.query(
                        'SELECT id FROM employees WHERE global_id = $1 AND tenant_id = $2',
                        [employee_global_id, tenant_id]
                    );
                    if (empResult.rows.length > 0) {
                        resolvedEmployeeId = empResult.rows[0].id;
                    }
                }

                const result = await pool.query(`
                    INSERT INTO kardex_entries (
                        tenant_id, branch_id, product_id, product_global_id,
                        timestamp, movement_type, employee_id, employee_global_id,
                        quantity_before, quantity_change, quantity_after,
                        description, sale_id, purchase_id, adjustment_id,
                        global_id, terminal_id, source,
                        created_at, updated_at
                    ) VALUES (
                        $1, $2, $3, $4,
                        $5, $6, $7, $8,
                        $9, $10, $11,
                        $12, $13, $14, $15,
                        $16, $17, $18,
                        NOW(), NOW()
                    )
                    ON CONFLICT (global_id) DO UPDATE SET
                        product_id = COALESCE(EXCLUDED.product_id, kardex_entries.product_id),
                        employee_id = COALESCE(EXCLUDED.employee_id, kardex_entries.employee_id),
                        updated_at = NOW()
                    RETURNING id, global_id`,
                    [
                        tenant_id,
                        branch_id || null,
                        resolvedProductId,
                        product_global_id || null,
                        timestamp || new Date().toISOString(),
                        movement_type,
                        resolvedEmployeeId,
                        employee_global_id || null,
                        quantity_before || 0,
                        quantity_change || 0,
                        quantity_after || 0,
                        description || '',
                        sale_id || null,
                        purchase_id || null,
                        adjustment_id || null,
                        global_id,
                        terminal_id || null,
                        source || 'desktop'
                    ]
                );

                results.push({ global_id, success: true, id: result.rows[0].id });
            }

            const allSuccess = results.every(r => r.success);
            res.status(allSuccess ? 200 : 207).json({
                success: allSuccess,
                data: results,
                synced: results.filter(r => r.success).length,
                failed: results.filter(r => !r.success).length
            });

        } catch (error) {
            console.error('[Kardex/Sync] ❌ Error:', error.message);
            res.status(500).json({ success: false, message: error.message });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // GET /api/kardex/pull - Descargar movimientos de kardex
    // Query params: tenant_id, product_global_id, since, limit
    // ═══════════════════════════════════════════════════════════════
    router.get('/pull', async (req, res) => {
        try {
            const tenantId = req.user.tenantId || req.query.tenantId;
            const { product_global_id, since, limit = 500, branch_id, date_from, date_to, product_sku } = req.query;

            console.log(`[Kardex/Pull] 📥 tenantId=${tenantId} (jwt=${req.user.tenantId}, query=${req.query.tenantId}), branch_id=${branch_id}, date_from=${date_from}, date_to=${date_to}, product_sku=${product_sku}`);

            if (!tenantId) {
                return res.status(400).json({ success: false, message: 'Se requiere tenantId' });
            }

            let query = `
                SELECT
                    k.id, k.tenant_id, k.branch_id,
                    k.product_id, k.product_global_id,
                    k.timestamp, k.movement_type,
                    k.employee_id, k.employee_global_id,
                    k.quantity_before, k.quantity_change, k.quantity_after,
                    k.description, k.sale_id, k.purchase_id, k.adjustment_id,
                    k.global_id, k.terminal_id, k.source,
                    k.created_at,
                    p.descripcion as product_name,
                    CONCAT(e.first_name, ' ', e.last_name) as employee_name
                FROM kardex_entries k
                LEFT JOIN productos p ON k.product_id = p.id
                LEFT JOIN employees e ON k.employee_id = e.id
                WHERE k.tenant_id = $1
            `;
            const params = [tenantId];
            let paramIndex = 2;

            if (product_global_id) {
                query += ` AND k.product_global_id = $${paramIndex}`;
                params.push(product_global_id);
                paramIndex++;
            }

            if (branch_id) {
                query += ` AND k.branch_id = $${paramIndex}`;
                params.push(branch_id);
                paramIndex++;
            }

            if (since) {
                query += ` AND k.created_at > $${paramIndex}`;
                params.push(since);
                paramIndex++;
            }

            if (date_from) {
                query += ` AND k.timestamp >= $${paramIndex}`;
                params.push(date_from);
                paramIndex++;
            }

            if (date_to) {
                query += ` AND k.timestamp < $${paramIndex}`;
                params.push(date_to);
                paramIndex++;
            }

            if (product_sku) {
                query += ` AND p.descripcion ILIKE $${paramIndex}`;
                params.push(`%${product_sku}%`);
                paramIndex++;
            }

            query += ` ORDER BY k.timestamp DESC LIMIT $${paramIndex}`;
            params.push(parseInt(limit));

            console.log(`[Kardex/Pull] 🔍 Query params: ${JSON.stringify(params)}`);
            const result = await pool.query(query, params);
            console.log(`[Kardex/Pull] ✅ ${result.rows.length} entries encontradas`);

            res.json({
                success: true,
                data: result.rows,
                count: result.rows.length
            });

        } catch (error) {
            console.error('[Kardex/Pull] ❌ Error:', error.message);
            res.status(500).json({ success: false, message: error.message });
        }
    });

    return router;
};
