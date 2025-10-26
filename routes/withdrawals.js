// ═══════════════════════════════════════════════════════════════
// WITHDRAWALS ROUTES - Manage cash withdrawals from drawer
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

    // GET /api/withdrawals - Get list of withdrawals
    router.get('/', authenticateToken, async (req, res) => {
        try {
            const { tenantId, branchId: userBranchId } = req.user;
            const { limit = 50, offset = 0, all_branches = 'false', branch_id, shiftId } = req.query;

            const targetBranchId = branch_id ? parseInt(branch_id) : userBranchId;

            let query = `
                SELECT w.id, w.tenant_id, w.branch_id, w.shift_id, w.employee_id,
                       w.amount, w.description, w.withdrawal_type,
                       w.withdrawal_date, w.created_at,
                       emp.full_name as employee_name, b.name as branch_name
                FROM withdrawals w
                LEFT JOIN employees emp ON w.employee_id = emp.id
                LEFT JOIN branches b ON w.branch_id = b.id
                WHERE w.tenant_id = $1
            `;

            const params = [tenantId];
            let paramIndex = 2;

            if (all_branches !== 'true' && targetBranchId) {
                query += ` AND w.branch_id = $${paramIndex}`;
                params.push(targetBranchId);
                paramIndex++;
            }

            if (shiftId) {
                query += ` AND w.shift_id = $${paramIndex}`;
                params.push(parseInt(shiftId));
                paramIndex++;
            }

            query += ` ORDER BY w.withdrawal_date DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
            params.push(limit, offset);

            console.log(`[Withdrawals] Fetching withdrawals - Tenant: ${tenantId}, Branch: ${targetBranchId}`);

            const result = await pool.query(query, params);

            const normalizedRows = result.rows.map(row => ({
                ...row,
                amount: parseFloat(row.amount),
                withdrawal_date: row.withdrawal_date ? new Date(row.withdrawal_date).toISOString() : null,
                created_at: row.created_at ? new Date(row.created_at).toISOString() : null
            }));

            res.json({
                success: true,
                data: normalizedRows,
                count: normalizedRows.length
            });
        } catch (error) {
            console.error('[Withdrawals] ❌ Error:', error.message);
            res.status(500).json({ success: false, message: 'Error al obtener retiros', error: error.message });
        }
    });

    // POST /api/withdrawals - Create new withdrawal
    router.post('/', authenticateToken, async (req, res) => {
        try {
            const { tenantId, branchId: userBranchId, id: employeeId } = req.user;
            const { amount, description, withdrawal_type = 'manual', shiftId, branchId } = req.body;

            const targetBranchId = branchId || userBranchId;

            if (!amount || amount <= 0) {
                return res.status(400).json({ success: false, message: 'Amount must be greater than 0' });
            }

            const numericAmount = parseFloat(amount);

            const result = await pool.query(
                `INSERT INTO withdrawals (tenant_id, branch_id, shift_id, employee_id, amount, description, withdrawal_type, withdrawal_date)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
                 RETURNING *`,
                [tenantId, targetBranchId, shiftId || null, employeeId, numericAmount, description || '', withdrawal_type]
            );

            const withdrawal = result.rows[0];
            console.log(`[Withdrawals] ✅ Withdrawal created: $${numericAmount} in branch ${targetBranchId}`);

            res.json({
                success: true,
                data: {
                    ...withdrawal,
                    amount: parseFloat(withdrawal.amount),
                    withdrawal_date: new Date(withdrawal.withdrawal_date).toISOString(),
                    created_at: new Date(withdrawal.created_at).toISOString()
                }
            });
        } catch (error) {
            console.error('[Withdrawals] ❌ Error creating withdrawal:', error.message);
            res.status(500).json({ success: false, message: 'Error al crear retiro', error: error.message });
        }
    });

    // POST /api/withdrawals/sync - Sync withdrawals from mobile/desktop
    router.post('/sync', authenticateToken, async (req, res) => {
        try {
            const { tenantId } = req.user;
            const withdrawals = Array.isArray(req.body) ? req.body : [req.body];

            console.log(`[Withdrawals/Sync] Syncing ${withdrawals.length} withdrawals for tenant ${tenantId}`);

            const results = [];

            for (const withdrawal of withdrawals) {
                try {
                    const { branchId, shiftId, employeeId, amount, description, withdrawalType = 'manual', withdrawalDate } = withdrawal;

                    if (!amount || amount <= 0 || !branchId) {
                        results.push({ success: false, error: 'Missing required fields' });
                        continue;
                    }

                    const numericAmount = parseFloat(amount);
                    const result = await pool.query(
                        `INSERT INTO withdrawals (tenant_id, branch_id, shift_id, employee_id, amount, description, withdrawal_type, withdrawal_date)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, NOW()))
                         RETURNING *`,
                        [tenantId, branchId, shiftId || null, employeeId || null, numericAmount, description || '', withdrawalType, withdrawalDate]
                    );

                    results.push({ success: true, data: result.rows[0] });
                    console.log(`[Withdrawals/Sync] ✅ Withdrawal synced: $${numericAmount}`);
                } catch (error) {
                    results.push({ success: false, error: error.message });
                    console.error(`[Withdrawals/Sync] ❌ Error:`, error.message);
                }
            }

            const successCount = results.filter(r => r.success).length;
            res.json({
                success: true,
                message: `${successCount}/${withdrawals.length} withdrawals synced`,
                results
            });
        } catch (error) {
            console.error('[Withdrawals/Sync] ❌ Error:', error.message);
            res.status(500).json({ success: false, message: 'Error syncing withdrawals', error: error.message });
        }
    });

    return router;
};
