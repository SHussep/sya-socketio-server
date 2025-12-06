// ═══════════════════════════════════════════════════════════════
// PURCHASES ROUTES - Extracted from server.js
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET;

// Middleware: Autenticación JWT
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ success: false, message: 'Token no proporcionado' });
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ success: false, message: 'Token inválido o expirado' });
        }
        req.user = user;
        next();
    });
}

module.exports = (pool) => {
    const router = express.Router();

    // GET /api/purchases - Lista de compras
    router.get('/', authenticateToken, async (req, res) => {
        try {
            const { tenantId, branchId } = req.user;
            const { limit = 50, offset = 0, all_branches = 'false' } = req.query;

            let query = `
                SELECT p.id, p.purchase_number, p.total_amount, p.payment_status, p.notes, p.purchase_date,
                       s.name as supplier_name,
                       CONCAT(emp.first_name, ' ', emp.last_name) as employee_name,
                       b.name as branch_name
                FROM purchases p
                LEFT JOIN suppliers s ON p.supplier_id = s.id
                LEFT JOIN employees emp ON p.employee_id = emp.id
                LEFT JOIN branches b ON p.branch_id = b.id
                WHERE p.tenant_id = $1
            `;

            const params = [tenantId];

            if (all_branches !== 'true' && branchId) {
                query += ' AND p.branch_id = $2';
                params.push(branchId);
                query += ' ORDER BY p.purchase_date DESC LIMIT $3 OFFSET $4';
                params.push(limit, offset);
            } else {
                query += ' ORDER BY p.purchase_date DESC LIMIT $2 OFFSET $3';
                params.push(limit, offset);
            }

            const result = await pool.query(query, params);

            // Format timestamps as ISO strings in UTC
            const formattedRows = result.rows.map(row => ({
                ...row,
                purchase_date: row.purchase_date ? new Date(row.purchase_date).toISOString() : null
            }));

            res.json({
                success: true,
                data: formattedRows
            });
        } catch (error) {
            console.error('[Purchases] Error:', error);
            res.status(500).json({ success: false, message: 'Error al obtener compras' });
        }
    });

    // POST /api/purchases - Crear compra desde Desktop (sin JWT)
    router.post('/', async (req, res) => {
        try {
            const { tenantId, branchId, supplierId, employeeId, purchaseNumber, totalAmount, paymentStatus, notes, userEmail } = req.body;

            if (!tenantId || !branchId || !supplierId || !purchaseNumber || !totalAmount) {
                return res.status(400).json({ success: false, message: 'Datos incompletos' });
            }

            // Buscar empleado por email si viene
            let finalEmployeeId = employeeId;
            if (!finalEmployeeId && userEmail) {
                const empResult = await pool.query(
                    'SELECT id FROM employees WHERE LOWER(email) = LOWER($1) AND tenant_id = $2',
                    [userEmail, tenantId]
                );
                if (empResult.rows.length > 0) {
                    finalEmployeeId = empResult.rows[0].id;
                }
            }

            const result = await pool.query(
                `INSERT INTO purchases (tenant_id, branch_id, supplier_id, employee_id, purchase_number, total_amount, payment_status, notes)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                 RETURNING *`,
                [tenantId, branchId, supplierId, finalEmployeeId, purchaseNumber, totalAmount, paymentStatus || 'pending', notes || null]
            );

            console.log(`[Purchases] ✅ Compra creada desde Desktop: ${purchaseNumber} - $${totalAmount}`);

            // Format timestamps as ISO strings in UTC
            const formattedData = {
                ...result.rows[0],
                purchase_date: result.rows[0].purchase_date ? new Date(result.rows[0].purchase_date).toISOString() : null
            };

            res.json({ success: true, data: formattedData });
        } catch (error) {
            console.error('[Purchases] Error:', error);
            res.status(500).json({ success: false, message: 'Error al crear compra' });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // POST /api/purchases/sync - Sincronización Offline-First desde Desktop
    // Soporta: global_id para idempotencia, detalles, campos completos
    // ═══════════════════════════════════════════════════════════════
    router.post('/sync', async (req, res) => {
        const client = await pool.connect();
        try {
            const {
                tenantId, branchId,
                employee_global_id, shift_global_id,
                proveedor_id, proveedor_name,
                status_id, payment_type_id,
                subtotal, taxes, total, amount_paid,
                notes, invoice_number, purchase_date_utc,
                userEmail, details,
                // Offline-first fields
                global_id, terminal_id, local_op_seq, created_local_utc
            } = req.body;

            console.log(`[Purchases/Sync] ════════════════════════════════════════════════════════`);
            console.log(`[Purchases/Sync] 📥 Recibida compra - GlobalId: ${global_id}`);
            console.log(`[Purchases/Sync]    Tenant: ${tenantId}, Branch: ${branchId}, Total: $${total}`);

            // Validación básica
            if (!tenantId || !branchId || !global_id) {
                console.log(`[Purchases/Sync] ❌ Datos incompletos`);
                return res.status(400).json({
                    success: false,
                    message: 'Datos incompletos (tenantId, branchId, global_id requeridos)'
                });
            }

            // IDEMPOTENCIA: Verificar si ya existe por global_id
            const existingCheck = await client.query(
                'SELECT id FROM purchases WHERE global_id = $1',
                [global_id]
            );

            if (existingCheck.rows.length > 0) {
                console.log(`[Purchases/Sync] ⚠️ Compra ${global_id} ya existe (ID: ${existingCheck.rows[0].id}) - Ignorando duplicado`);
                return res.json({
                    success: true,
                    message: 'Compra ya sincronizada anteriormente',
                    data: { id: existingCheck.rows[0].id, global_id }
                });
            }

            await client.query('BEGIN');

            // Resolver employee_id desde global_id
            let employeeId = null;
            if (employee_global_id) {
                const empResult = await client.query(
                    'SELECT id FROM employees WHERE global_id = $1 AND tenant_id = $2',
                    [employee_global_id, tenantId]
                );
                if (empResult.rows.length > 0) {
                    employeeId = empResult.rows[0].id;
                }
            }

            // Resolver shift_id desde global_id
            let shiftId = null;
            if (shift_global_id) {
                const shiftResult = await client.query(
                    'SELECT id FROM shifts WHERE global_id = $1',
                    [shift_global_id]
                );
                if (shiftResult.rows.length > 0) {
                    shiftId = shiftResult.rows[0].id;
                }
            }

            // Mapear status_id a payment_status
            const statusMap = { 1: 'pending', 2: 'paid', 3: 'partial', 4: 'cancelled' };
            const paymentStatus = statusMap[status_id] || 'pending';

            // Generar purchase_number si no viene (usando global_id corto o timestamp)
            const purchaseNumber = invoice_number || `PUR-${global_id.substring(0, 8).toUpperCase()}`;

            // Insertar compra
            const purchaseResult = await client.query(
                `INSERT INTO purchases (
                    tenant_id, branch_id, supplier_id, supplier_name, employee_id, shift_id,
                    purchase_number, subtotal, taxes, total_amount, amount_paid, payment_status, payment_type_id,
                    notes, invoice_number, purchase_date,
                    global_id, terminal_id, local_op_seq, created_local_utc
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
                RETURNING id`,
                [
                    tenantId, branchId, proveedor_id, proveedor_name, employeeId, shiftId,
                    purchaseNumber, subtotal || 0, taxes || 0, total || 0, amount_paid || 0, paymentStatus, payment_type_id,
                    notes || null, invoice_number || null, purchase_date_utc ? new Date(purchase_date_utc) : new Date(),
                    global_id, terminal_id, local_op_seq, created_local_utc
                ]
            );

            const purchaseId = purchaseResult.rows[0].id;
            console.log(`[Purchases/Sync] ✅ Compra insertada con ID: ${purchaseId}`);

            // Insertar detalles si vienen
            if (details && Array.isArray(details) && details.length > 0) {
                for (const detail of details) {
                    await client.query(
                        `INSERT INTO purchase_details (
                            purchase_id, product_id, product_name, quantity, unit_price, subtotal, global_id
                        ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                        [
                            purchaseId,
                            detail.product_id,
                            detail.product_name || `Producto ${detail.product_id}`,
                            detail.quantity || 0,
                            detail.unit_price || 0,
                            detail.subtotal || (detail.quantity * detail.unit_price) || 0,
                            detail.global_id
                        ]
                    );
                }
                console.log(`[Purchases/Sync] ✅ ${details.length} detalles insertados`);
            }

            await client.query('COMMIT');

            console.log(`[Purchases/Sync] ✅ Compra ${global_id} sincronizada exitosamente`);
            res.json({
                success: true,
                data: { id: purchaseId, global_id }
            });

        } catch (error) {
            await client.query('ROLLBACK');
            console.error('[Purchases/Sync] ❌ Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al sincronizar compra',
                error: error.message
            });
        } finally {
            client.release();
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // PATCH /api/purchases/:globalId/cancel - Cancelar compra
    // ═══════════════════════════════════════════════════════════════
    router.patch('/:globalId/cancel', async (req, res) => {
        try {
            const { globalId } = req.params;
            const { tenant_id, status_id, last_modified_local_utc } = req.body;

            console.log(`[Purchases/Cancel] 🔄 Cancelando compra ${globalId}`);

            const result = await pool.query(
                `UPDATE purchases
                 SET payment_status = 'cancelled',
                     updated_at = NOW(),
                     last_modified_local_utc = $1
                 WHERE global_id = $2 AND tenant_id = $3
                 RETURNING id`,
                [last_modified_local_utc, globalId, tenant_id]
            );

            if (result.rows.length === 0) {
                console.log(`[Purchases/Cancel] ❌ Compra ${globalId} no encontrada`);
                return res.status(404).json({ success: false, message: 'Compra no encontrada' });
            }

            console.log(`[Purchases/Cancel] ✅ Compra ${globalId} cancelada`);
            res.json({ success: true, data: { id: result.rows[0].id, global_id: globalId } });

        } catch (error) {
            console.error('[Purchases/Cancel] ❌ Error:', error);
            res.status(500).json({ success: false, message: 'Error al cancelar compra', error: error.message });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // PUT /api/purchases/:globalId - Actualizar compra (pagos, etc.)
    // ═══════════════════════════════════════════════════════════════
    router.put('/:globalId', async (req, res) => {
        try {
            const { globalId } = req.params;
            const { tenant_id, status_id, payment_type_id, amount_paid, notes, invoice_number, last_modified_local_utc } = req.body;

            console.log(`[Purchases/Update] 🔄 Actualizando compra ${globalId}`);

            const statusMap = { 1: 'pending', 2: 'paid', 3: 'partial', 4: 'cancelled' };
            const paymentStatus = statusMap[status_id] || 'pending';

            const result = await pool.query(
                `UPDATE purchases
                 SET payment_status = $1,
                     payment_type_id = $2,
                     amount_paid = $3,
                     notes = $4,
                     invoice_number = $5,
                     updated_at = NOW(),
                     last_modified_local_utc = $6
                 WHERE global_id = $7 AND tenant_id = $8
                 RETURNING id`,
                [paymentStatus, payment_type_id, amount_paid, notes, invoice_number, last_modified_local_utc, globalId, tenant_id]
            );

            if (result.rows.length === 0) {
                console.log(`[Purchases/Update] ❌ Compra ${globalId} no encontrada`);
                return res.status(404).json({ success: false, message: 'Compra no encontrada' });
            }

            console.log(`[Purchases/Update] ✅ Compra ${globalId} actualizada`);
            res.json({ success: true, data: { id: result.rows[0].id, global_id: globalId } });

        } catch (error) {
            console.error('[Purchases/Update] ❌ Error:', error);
            res.status(500).json({ success: false, message: 'Error al actualizar compra', error: error.message });
        }
    });

    return router;
};
