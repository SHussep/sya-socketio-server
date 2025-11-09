// ═══════════════════════════════════════════════════════════════
// DEPOSITS ROUTES - Manage cash deposits/additions
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

    // GET /api/deposits - Get list of deposits
    router.get('/', authenticateToken, async (req, res) => {
        try {
            const { tenantId, branchId: userBranchId } = req.user;
            const { limit = 50, offset = 0, all_branches = 'false', branch_id, shiftId } = req.query;

            const targetBranchId = branch_id ? parseInt(branch_id) : userBranchId;

            let query = `
                SELECT d.id, d.tenant_id, d.branch_id, d.shift_id, d.employee_id,
                       d.amount, d.description, d.deposit_type,
                       d.deposit_date, d.created_at,
                       emp.full_name as employee_name, b.name as branch_name
                FROM deposits d
                LEFT JOIN employees emp ON d.employee_id = emp.id
                LEFT JOIN branches b ON d.branch_id = b.id
                WHERE d.tenant_id = $1
            `;

            const params = [tenantId];
            let paramIndex = 2;

            if (all_branches !== 'true' && targetBranchId) {
                query += ` AND d.branch_id = $${paramIndex}`;
                params.push(targetBranchId);
                paramIndex++;
            }

            if (shiftId) {
                query += ` AND d.shift_id = $${paramIndex}`;
                params.push(parseInt(shiftId));
                paramIndex++;
            }

            query += ` ORDER BY d.deposit_date DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
            params.push(limit, offset);

            console.log(`[Deposits] Fetching deposits - Tenant: ${tenantId}, Branch: ${targetBranchId}`);

            const result = await pool.query(query, params);

            const normalizedRows = result.rows.map(row => ({
                ...row,
                amount: parseFloat(row.amount),
                deposit_date: row.deposit_date ? new Date(row.deposit_date).toISOString() : null,
                created_at: row.created_at ? new Date(row.created_at).toISOString() : null
            }));

            res.json({
                success: true,
                data: normalizedRows,
                count: normalizedRows.length
            });
        } catch (error) {
            console.error('[Deposits] ❌ Error:', error.message);
            res.status(500).json({ success: false, message: 'Error al obtener depósitos', error: error.message });
        }
    });

    // POST /api/deposits - Create new deposit (SIN AUTENTICACIÓN - para Desktop offline-first)
    router.post('/', async (req, res) => {
        try {
            const { tenantId, branchId, employeeId, amount, description, deposit_type = 'manual', shiftId } = req.body;

            if (!tenantId || !branchId) {
                return res.status(400).json({ success: false, message: 'tenantId y branchId son requeridos' });
            }

            if (!amount || amount <= 0) {
                return res.status(400).json({ success: false, message: 'Amount must be greater than 0' });
            }

            const numericAmount = parseFloat(amount);

            const result = await pool.query(
                `INSERT INTO deposits (tenant_id, branch_id, shift_id, employee_id, amount, description, deposit_type, deposit_date)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
                 RETURNING *`,
                [tenantId, branchId, shiftId || null, employeeId, numericAmount, description || '', deposit_type]
            );

            const deposit = result.rows[0];
            console.log(`[Deposits] ✅ Deposit created: $${numericAmount} in branch ${branchId}`);

            res.json({
                success: true,
                data: {
                    ...deposit,
                    amount: parseFloat(deposit.amount),
                    deposit_date: new Date(deposit.deposit_date).toISOString(),
                    created_at: new Date(deposit.created_at).toISOString()
                }
            });
        } catch (error) {
            console.error('[Deposits] ❌ Error creating deposit:', error.message);
            res.status(500).json({ success: false, message: 'Error al crear depósito', error: error.message });
        }
    });

    // POST /api/deposits/sync - Sync deposits from mobile/desktop (SIN AUTENTICACIÓN - para Desktop offline-first)
    // ✅ Soporte completo para idempotencia con global_id
    router.post('/sync', async (req, res) => {
        try {
            const deposits = Array.isArray(req.body) ? req.body : [req.body];

            // Obtener tenantId del primer depósito
            if (deposits.length === 0 || !deposits[0].tenantId) {
                return res.status(400).json({ success: false, message: 'tenantId es requerido' });
            }
            const { tenantId } = deposits[0];

            console.log(`[Deposits/Sync] Syncing ${deposits.length} deposits for tenant ${tenantId}`);

            const results = [];

            for (const deposit of deposits) {
                try {
                    const {
                        branchId, shiftId, employeeId, amount, description,
                        deposit_type = 'manual', deposit_date, localShiftId,
                        // Campos offline-first para idempotencia
                        global_id, terminal_id, local_op_seq, device_event_raw, created_local_utc
                    } = deposit;

                    if (!amount || amount <= 0 || !branchId) {
                        results.push({ success: false, error: 'Missing required fields' });
                        continue;
                    }

                    const numericAmount = parseFloat(amount);

                    // ✅ UPSERT con global_id para evitar duplicados
                    const result = await pool.query(
                        `INSERT INTO deposits (
                            tenant_id, branch_id, shift_id, local_shift_id, employee_id,
                            amount, description, deposit_type, deposit_date,
                            global_id, terminal_id, local_op_seq, device_event_raw, created_local_utc
                        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, NOW()), $10, $11, $12, $13, $14)
                         ON CONFLICT (global_id) WHERE global_id IS NOT NULL
                         DO UPDATE SET
                            amount = EXCLUDED.amount,
                            description = EXCLUDED.description,
                            synced_at = NOW()
                         RETURNING *`,
                        [
                            tenantId, branchId, shiftId || null, localShiftId || null, employeeId || null,
                            numericAmount, description || '', deposit_type, deposit_date,
                            global_id, terminal_id, local_op_seq, device_event_raw, created_local_utc
                        ]
                    );

                    results.push({ success: true, data: result.rows[0] });
                    console.log(`[Deposits/Sync] ✅ Deposit synced: $${numericAmount} (global_id: ${global_id})`);
                } catch (error) {
                    results.push({ success: false, error: error.message });
                    console.error(`[Deposits/Sync] ❌ Error:`, error.message);
                }
            }

            const successCount = results.filter(r => r.success).length;
            res.json({
                success: true,
                message: `${successCount}/${deposits.length} deposits synced`,
                results
            });
        } catch (error) {
            console.error('[Deposits/Sync] ❌ Error:', error.message);
            res.status(500).json({ success: false, message: 'Error syncing deposits', error: error.message });
        }
    });

    return router;
};
