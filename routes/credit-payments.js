// ═══════════════════════════════════════════════════════════════
// CREDIT PAYMENTS ROUTES - Pagos de crédito de clientes
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

module.exports = (pool, io) => {
    const requireDesktopOnline = require('../middleware/requireDesktopOnline');
    const router = express.Router();

    // GET /api/credit-payments - Lista de pagos de crédito
    router.get('/', authenticateToken, async (req, res) => {
        try {
            const { tenantId, branchId: userBranchId } = req.user;
            const { limit = 50, offset = 0, customer_id, shift_id, all_branches = 'false', branch_id } = req.query;

            const targetBranchId = branch_id ? parseInt(branch_id) : userBranchId;

            let query = `
                SELECT cp.id, cp.tenant_id, cp.branch_id, cp.customer_id, cp.shift_id, cp.employee_id,
                       cp.amount, cp.payment_method, cp.payment_date, cp.notes,
                       c.nombre as customer_name, CONCAT(e.first_name, ' ', e.last_name) as employee_name, b.name as branch_name,
                       cp.created_at
                FROM credit_payments cp
                LEFT JOIN customers c ON cp.customer_id = c.id
                LEFT JOIN employees e ON cp.employee_id = e.id
                LEFT JOIN branches b ON cp.branch_id = b.id
                WHERE cp.tenant_id = $1
            `;

            const params = [tenantId];
            let paramIndex = 2;

            if (all_branches !== 'true' && targetBranchId) {
                query += ` AND cp.branch_id = $${paramIndex}`;
                params.push(targetBranchId);
                paramIndex++;
            }

            if (customer_id) {
                query += ` AND cp.customer_id = $${paramIndex}`;
                params.push(parseInt(customer_id));
                paramIndex++;
            }

            if (shift_id) {
                query += ` AND cp.shift_id = $${paramIndex}`;
                params.push(parseInt(shift_id));
                paramIndex++;
            }

            query += ` ORDER BY cp.payment_date DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
            params.push(limit, offset);

            console.log(`[CreditPayments] Fetching payments - Tenant: ${tenantId}, Branch: ${targetBranchId}`);

            const result = await pool.query(query, params);

            const normalizedRows = result.rows.map(row => ({
                ...row,
                amount: parseFloat(row.amount),
                payment_date: row.payment_date ? new Date(row.payment_date).toISOString() : null,
                created_at: row.created_at ? new Date(row.created_at).toISOString() : null
            }));

            res.json({
                success: true,
                data: normalizedRows,
                count: normalizedRows.length
            });
        } catch (error) {
            console.error('[CreditPayments] ❌ Error:', error.message);
            res.status(500).json({ success: false, message: 'Error al obtener pagos de crédito', error: undefined });
        }
    });

    // POST /api/credit-payments — Direct server-first creation
    router.post('/', authenticateToken, requireDesktopOnline({ action: 'registrar un pago de cliente' }), async (req, res) => {
        try {
            const tenantId = req.user.tenantId;
            const { branchId, customerId, customer_global_id, shiftId, shift_global_id,
                    employeeId, employee_global_id, amount, paymentMethod, notes,
                    global_id, terminal_id, created_local_utc } = req.body;

            if (!amount || amount <= 0) {
                return res.status(400).json({ success: false, message: 'Amount must be > 0' });
            }

            // Resolve global IDs to PG IDs
            let finalCustomerId = customerId;
            if (!finalCustomerId && customer_global_id) {
                const r = await pool.query(
                    'SELECT id FROM customers WHERE global_id = $1 AND tenant_id = $2',
                    [customer_global_id, tenantId]);
                if (r.rows.length > 0) finalCustomerId = r.rows[0].id;
            }
            if (!finalCustomerId) {
                return res.status(400).json({ success: false, message: 'Customer not found' });
            }

            let finalShiftId = shiftId;
            if (!finalShiftId && shift_global_id) {
                const r = await pool.query(
                    'SELECT id FROM shifts WHERE global_id = $1 AND tenant_id = $2',
                    [shift_global_id, tenantId]);
                if (r.rows.length > 0) finalShiftId = r.rows[0].id;
            }

            let finalEmployeeId = employeeId || req.user.employeeId;
            if (!finalEmployeeId && employee_global_id) {
                const r = await pool.query(
                    'SELECT id FROM employees WHERE global_id = $1 AND tenant_id = $2',
                    [employee_global_id, tenantId]);
                if (r.rows.length > 0) finalEmployeeId = r.rows[0].id;
            }

            const finalGlobalId = global_id || require('uuid').v4();
            const finalBranchId = branchId || req.user.branchId;

            // Idempotency: DO NOTHING on conflict
            const client = await pool.connect();
            let paymentRow;
            let isNewPayment = false;
            try {
                await client.query('BEGIN');

                const result = await client.query(`
                    INSERT INTO credit_payments (
                        tenant_id, branch_id, customer_id, shift_id, employee_id,
                        amount, payment_method, payment_date, notes,
                        global_id, terminal_id, created_local_utc
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8, $9, $10, $11)
                    ON CONFLICT (global_id) DO NOTHING
                    RETURNING *
                `, [tenantId, finalBranchId, finalCustomerId, finalShiftId,
                    finalEmployeeId, amount, paymentMethod || 'cash', notes,
                    finalGlobalId, terminal_id, created_local_utc]);

                if (result.rows.length > 0) {
                    paymentRow = result.rows[0];
                    isNewPayment = true;

                    // Update customer balance (decrement saldo_deudor)
                    await client.query(
                        `UPDATE customers SET saldo_deudor = GREATEST(0, COALESCE(saldo_deudor, 0) - $1)
                         WHERE id = $2 AND tenant_id = $3`,
                        [parseFloat(amount), finalCustomerId, tenantId]
                    );
                    console.log(`[CreditPayments] ✅ Customer ${finalCustomerId} balance decremented by $${amount}`);
                } else {
                    // Already existed — fetch existing
                    const existing = await client.query(
                        'SELECT * FROM credit_payments WHERE global_id = $1', [finalGlobalId]);
                    paymentRow = existing.rows[0];
                }

                await client.query('COMMIT');
            } catch (txErr) {
                await client.query('ROLLBACK');
                throw txErr;
            } finally {
                client.release();
            }

            // Socket notification (only for new payments)
            if (io && isNewPayment) {
                const roomName = `branch_${paymentRow.branch_id}`;
                io.to(roomName).emit('credit_payment_created', {
                    paymentId: paymentRow.id,
                    customerId: paymentRow.customer_id,
                    amount: parseFloat(paymentRow.amount),
                    branchId: paymentRow.branch_id
                });
            }

            res.status(201).json({ success: true, data: paymentRow });
        } catch (err) {
            console.error('[CreditPayments] POST error:', err.message);
            res.status(500).json({ success: false, message: err.message });
        }
    });

    // POST /api/credit-payments/sync - Sincronizar pagos desde Desktop
    // ✅ ACTUALIZADO: Soporta resolución de GlobalIds para relaciones
    router.post('/sync', authenticateToken, async (req, res) => {
        try {
            const payments = Array.isArray(req.body) ? req.body : [req.body];

            // Rate limit: max 200 items per batch
            if (Array.isArray(payments) && payments.length > 200) {
                return res.status(400).json({
                    success: false,
                    message: `Batch demasiado grande (${payments.length} items). Máximo 200 por request.`
                });
            }

            // Obtener tenantId del primer pago
            if (payments.length === 0 || !payments[0].tenantId) {
                return res.status(400).json({ success: false, message: 'tenantId es requerido' });
            }
            const { tenantId } = payments[0];

            console.log(`[CreditPayments/Sync] Syncing ${payments.length} payments for tenant ${tenantId}`);

            const results = [];

            for (const payment of payments) {
                try {
                    const {
                        tenantId: paymentTenantId, branchId, customerId, shiftId, employeeId,
                        amount, paymentMethod, paymentDate, notes,
                        // ✅ NUEVO: GlobalIds para resolución offline-first
                        customer_global_id, shift_global_id, employee_global_id,
                        // Campos offline-first para idempotencia
                        global_id, terminal_id, local_op_seq, device_event_raw, created_local_utc
                    } = payment;

                    const effectiveTenantId = paymentTenantId || tenantId;

                    // ✅ RESOLVER customer_global_id → PostgreSQL ID
                    let finalCustomerId = customerId || null;
                    if (customer_global_id) {
                        const custResult = await pool.query(
                            'SELECT id FROM customers WHERE global_id = $1 AND tenant_id = $2',
                            [customer_global_id, effectiveTenantId]
                        );
                        if (custResult.rows.length > 0) {
                            finalCustomerId = custResult.rows[0].id;
                            console.log(`[CreditPayments/Sync] ✅ Cliente resuelto: ${customer_global_id} → ${finalCustomerId}`);
                        } else {
                            console.log(`[CreditPayments/Sync] ❌ Cliente no encontrado: ${customer_global_id}`);
                            results.push({ success: false, error: `Cliente no encontrado: ${customer_global_id}`, global_id });
                            continue;
                        }
                    }

                    // ✅ RESOLVER shift_global_id → PostgreSQL ID
                    let finalShiftId = shiftId || null;
                    if (shift_global_id) {
                        const shiftResult = await pool.query(
                            'SELECT id FROM shifts WHERE global_id = $1 AND tenant_id = $2',
                            [shift_global_id, effectiveTenantId]
                        );
                        if (shiftResult.rows.length > 0) {
                            finalShiftId = shiftResult.rows[0].id;
                            console.log(`[CreditPayments/Sync] ✅ Turno resuelto: ${shift_global_id} → ${finalShiftId}`);
                        } else {
                            console.log(`[CreditPayments/Sync] ⚠️ Turno no encontrado: ${shift_global_id}`);
                        }
                    }

                    // ✅ RESOLVER employee_global_id → PostgreSQL ID
                    let finalEmployeeId = employeeId || null;
                    if (employee_global_id) {
                        const empResult = await pool.query(
                            'SELECT id FROM employees WHERE global_id = $1 AND tenant_id = $2',
                            [employee_global_id, effectiveTenantId]
                        );
                        if (empResult.rows.length > 0) {
                            finalEmployeeId = empResult.rows[0].id;
                            console.log(`[CreditPayments/Sync] ✅ Empleado resuelto: ${employee_global_id} → ${finalEmployeeId}`);
                        } else {
                            console.log(`[CreditPayments/Sync] ⚠️ Empleado no encontrado: ${employee_global_id}`);
                        }
                    }

                    if (!finalCustomerId || !amount || !paymentMethod || !branchId) {
                        results.push({ success: false, error: 'Missing required fields (customerId/customer_global_id, amount, paymentMethod, branchId)', global_id });
                        continue;
                    }

                    const numericAmount = parseFloat(amount);

                    // ✅ UPSERT con global_id para evitar duplicados
                    const result = await pool.query(
                        `INSERT INTO credit_payments (
                            tenant_id, branch_id, customer_id, shift_id, employee_id,
                            amount, payment_method, payment_date, notes,
                            global_id, terminal_id, local_op_seq, device_event_raw, created_local_utc
                        ) VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, NOW()), $9, $10, $11, $12, $13, $14)
                         ON CONFLICT (global_id)
                         DO UPDATE SET
                            amount = EXCLUDED.amount,
                            notes = EXCLUDED.notes,
                            customer_id = EXCLUDED.customer_id,
                            shift_id = EXCLUDED.shift_id,
                            employee_id = EXCLUDED.employee_id
                         RETURNING *`,
                        [
                            effectiveTenantId, branchId, finalCustomerId, finalShiftId, finalEmployeeId,
                            numericAmount, paymentMethod, paymentDate,
                            notes || null,
                            global_id, terminal_id, local_op_seq, device_event_raw, created_local_utc
                        ]
                    );

                    results.push({ success: true, data: result.rows[0] });
                    console.log(`[CreditPayments/Sync] ✅ Payment synced: $${numericAmount} from customer ${finalCustomerId} (global_id: ${global_id})`);
                } catch (error) {
                    results.push({ success: false, error: undefined, global_id: payment.global_id });
                    console.error(`[CreditPayments/Sync] ❌ Error:`, error.message);
                }
            }

            const successCount = results.filter(r => r.success).length;
            res.json({
                success: true,
                message: `${successCount}/${payments.length} payments synced`,
                results
            });
        } catch (error) {
            console.error('[CreditPayments/Sync] ❌ Error:', error.message);
            res.status(500).json({ success: false, message: 'Error syncing credit payments', error: undefined });
        }
    });

    // GET /api/credit-payments/pull - Incremental sync pull
    router.get('/pull', authenticateToken, async (req, res) => {
        try {
            const tenantId = req.user.tenantId;
            const branchId = req.query.branch_id || req.user.branchId;
            const since = req.query.since || '1970-01-01T00:00:00Z';
            const limit = Math.min(parseInt(req.query.limit) || 500, 1000);

            const result = await pool.query(`
                SELECT cp.*,
                       c.global_id as customer_global_id,
                       emp.global_id as employee_global_id,
                       s.global_id as shift_global_id
                FROM credit_payments cp
                LEFT JOIN customers c ON cp.customer_id = c.id
                LEFT JOIN employees emp ON cp.employee_id = emp.id
                LEFT JOIN shifts s ON cp.shift_id = s.id
                WHERE cp.tenant_id = $1 AND cp.branch_id = $2
                  AND cp.created_at > $3
                ORDER BY cp.created_at ASC
                LIMIT $4
            `, [tenantId, branchId, since, limit]);

            const lastSync = result.rows.length > 0
                ? result.rows[result.rows.length - 1].created_at
                : since;

            res.json({
                success: true,
                data: { credit_payments: result.rows, last_sync: lastSync },
                count: result.rows.length
            });
        } catch (err) {
            res.status(500).json({ success: false, message: err.message });
        }
    });

    // GET /api/credit-payments/customer/:customerId - Historial de pagos de un cliente con saldo anterior
    router.get('/customer/:customerId', authenticateToken, async (req, res) => {
        try {
            const { tenantId } = req.user;
            const { customerId } = req.params;
            const { limit = 50, include_balance = 'true' } = req.query;

            console.log(`[CreditPayments/History] 📊 Obteniendo historial para cliente ${customerId}, tenant ${tenantId}`);

            // 1. Obtener pagos con info detallada
            const paymentsResult = await pool.query(
                `SELECT cp.id, cp.amount, cp.payment_method, cp.payment_date, cp.notes,
                        cp.branch_id, cp.employee_id, cp.shift_id,
                        CONCAT(e.first_name, ' ', e.last_name) as employee_name,
                        b.name as branch_name,
                        cp.created_at
                 FROM credit_payments cp
                 LEFT JOIN employees e ON cp.employee_id = e.id
                 LEFT JOIN branches b ON cp.branch_id = b.id
                 WHERE cp.tenant_id = $1 AND cp.customer_id = $2
                 ORDER BY cp.payment_date DESC
                 LIMIT $3`,
                [tenantId, parseInt(customerId), parseInt(limit)]
            );

            let normalizedPayments = paymentsResult.rows.map(row => ({
                ...row,
                amount: parseFloat(row.amount),
                payment_date: row.payment_date ? new Date(row.payment_date).toISOString() : null,
                created_at: row.created_at ? new Date(row.created_at).toISOString() : null
            }));

            // 2. Si se requiere balance, calcular saldo antes/después de cada pago
            if (include_balance === 'true' && normalizedPayments.length > 0) {
                // Obtener TODAS las transacciones del cliente ordenadas por fecha
                // ✅ FIX: Incluir ventas mixtas (tipo_pago_id = 4) con crédito
                const transactionsResult = await pool.query(
                    `SELECT * FROM (
                        -- Ventas a crédito (aumentan deuda)
                        -- Incluye crédito puro (3) y ventas mixtas (4) con credito_original > 0
                        SELECT
                            'sale' as type,
                            id_venta as id,
                            ticket_number,
                            -- Para crédito puro usar total, para mixto usar credito_original
                            CASE tipo_pago_id
                                WHEN 3 THEN total
                                ELSE COALESCE(credito_original, total - COALESCE(monto_pagado, 0))
                            END as amount,
                            fecha_venta_utc as date
                        FROM ventas
                        WHERE id_cliente = $1 AND tenant_id = $2
                            AND (
                                tipo_pago_id = 3  -- Crédito puro
                                OR (tipo_pago_id = 4 AND COALESCE(credito_original, 0) > 0)  -- Mixto con crédito
                            )

                        UNION ALL

                        -- Pagos (reducen deuda)
                        SELECT
                            'payment' as type,
                            id,
                            NULL as ticket_number,
                            amount,
                            payment_date as date
                        FROM credit_payments
                        WHERE customer_id = $1 AND tenant_id = $2
                    ) AS transactions
                    ORDER BY date ASC`,
                    [parseInt(customerId), tenantId]
                );

                // Calcular running balance
                let runningBalance = 0;
                const balanceByPaymentId = {};

                for (const tx of transactionsResult.rows) {
                    const amount = parseFloat(tx.amount);
                    if (tx.type === 'sale') {
                        runningBalance += amount;
                    } else if (tx.type === 'payment') {
                        // Guardar saldo ANTES del pago
                        balanceByPaymentId[tx.id] = {
                            balance_before: runningBalance,
                            balance_after: runningBalance - amount
                        };
                        runningBalance -= amount;
                    }
                }

                // Agregar balance_before y balance_after a cada pago
                normalizedPayments = normalizedPayments.map(payment => ({
                    ...payment,
                    balance_before: balanceByPaymentId[payment.id]?.balance_before ?? null,
                    balance_after: balanceByPaymentId[payment.id]?.balance_after ?? null
                }));

                console.log(`[CreditPayments/History] ✅ ${normalizedPayments.length} pagos con balance calculado`);
            }

            // 3. Calcular totales
            const totalPaid = normalizedPayments.reduce((sum, p) => sum + p.amount, 0);
            const totalPayments = normalizedPayments.length;

            // 4. Obtener saldo actual del cliente
            const customerResult = await pool.query(
                'SELECT saldo_deudor FROM customers WHERE id = $1 AND tenant_id = $2',
                [parseInt(customerId), tenantId]
            );
            const currentBalance = customerResult.rows[0]?.saldo_deudor
                ? parseFloat(customerResult.rows[0].saldo_deudor)
                : 0;

            res.json({
                success: true,
                data: normalizedPayments,
                summary: {
                    total_paid: totalPaid,
                    total_payments: totalPayments,
                    current_balance: currentBalance
                }
            });
        } catch (error) {
            console.error('[CreditPayments] ❌ Error:', error.message);
            res.status(500).json({ success: false, message: 'Error al obtener historial', error: undefined });
        }
    });

    // GET /api/credit-payments/summary - Resumen de cobros
    router.get('/summary', authenticateToken, async (req, res) => {
        try {
            const { tenantId, branchId } = req.user;
            const { date_from, date_to } = req.query;

            let query = `
                SELECT
                    DATE(payment_date) as date,
                    payment_method,
                    COUNT(*) as payment_count,
                    SUM(amount) as total_amount
                FROM credit_payments
                WHERE tenant_id = $1 AND branch_id = $2
            `;

            const params = [tenantId, branchId];
            let paramIndex = 3;

            if (date_from) {
                query += ` AND payment_date >= $${paramIndex}`;
                params.push(date_from);
                paramIndex++;
            }

            if (date_to) {
                query += ` AND payment_date <= $${paramIndex}`;
                params.push(date_to);
                paramIndex++;
            }

            query += ` GROUP BY DATE(payment_date), payment_method ORDER BY date DESC`;

            const result = await pool.query(query, params);

            const normalizedRows = result.rows.map(row => ({
                ...row,
                total_amount: parseFloat(row.total_amount)
            }));

            res.json({
                success: true,
                data: normalizedRows
            });
        } catch (error) {
            console.error('[CreditPayments] ❌ Error:', error.message);
            res.status(500).json({ success: false, message: 'Error al obtener resumen', error: undefined });
        }
    });

    return router;
};
