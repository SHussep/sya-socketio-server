// ═══════════════════════════════════════════════════════════════
// CASH CUTS ROUTES - Complete cash cut session management
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

    // GET /api/cash-cuts - Get list of cash cuts
    router.get('/', authenticateToken, async (req, res) => {
        try {
            const { tenantId, branchId: userBranchId } = req.user;
            const { limit = 50, offset = 0, all_branches = 'false', branch_id, shiftId, is_closed } = req.query;

            const targetBranchId = branch_id ? parseInt(branch_id) : userBranchId;

            let query = `
                SELECT cc.id, cc.tenant_id, cc.branch_id, cc.shift_id, cc.employee_id,
                       cc.start_time, cc.end_time,
                       cc.initial_amount, cc.total_cash_sales, cc.total_card_sales, cc.total_credit_sales,
                       cc.total_cash_payments, cc.total_card_payments,
                       cc.total_expenses, cc.total_deposits, cc.total_withdrawals,
                       cc.expected_cash_in_drawer, cc.counted_cash, cc.difference,
                       cc.unregistered_weight_events, cc.scale_connection_events, cc.cancelled_sales,
                       cc.notes, cc.is_closed, cc.created_at, cc.updated_at,
                       emp.full_name as employee_name, b.name as branch_name
                FROM cash_cuts cc
                LEFT JOIN employees emp ON cc.employee_id = emp.id
                LEFT JOIN branches b ON cc.branch_id = b.id
                WHERE cc.tenant_id = $1
            `;

            const params = [tenantId];
            let paramIndex = 2;

            if (all_branches !== 'true' && targetBranchId) {
                query += ` AND cc.branch_id = $${paramIndex}`;
                params.push(targetBranchId);
                paramIndex++;
            }

            if (shiftId) {
                query += ` AND cc.shift_id = $${paramIndex}`;
                params.push(parseInt(shiftId));
                paramIndex++;
            }

            if (is_closed) {
                query += ` AND cc.is_closed = $${paramIndex}`;
                params.push(is_closed === 'true');
                paramIndex++;
            }

            query += ` ORDER BY cc.start_time DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
            params.push(limit, offset);

            console.log(`[CashCuts] Fetching cash cuts - Tenant: ${tenantId}, Branch: ${targetBranchId}`);

            const result = await pool.query(query, params);

            const normalizedRows = result.rows.map(row => ({
                ...row,
                initial_amount: parseFloat(row.initial_amount),
                total_cash_sales: parseFloat(row.total_cash_sales),
                total_card_sales: parseFloat(row.total_card_sales),
                total_credit_sales: parseFloat(row.total_credit_sales),
                total_cash_payments: parseFloat(row.total_cash_payments),
                total_card_payments: parseFloat(row.total_card_payments),
                total_expenses: parseFloat(row.total_expenses),
                total_deposits: parseFloat(row.total_deposits),
                total_withdrawals: parseFloat(row.total_withdrawals),
                expected_cash_in_drawer: parseFloat(row.expected_cash_in_drawer),
                counted_cash: parseFloat(row.counted_cash),
                difference: parseFloat(row.difference),
                start_time: row.start_time ? new Date(row.start_time).toISOString() : null,
                end_time: row.end_time ? new Date(row.end_time).toISOString() : null,
                created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
                updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null
            }));

            res.json({
                success: true,
                data: normalizedRows,
                count: normalizedRows.length
            });
        } catch (error) {
            console.error('[CashCuts] ❌ Error:', error.message);
            res.status(500).json({ success: false, message: 'Error al obtener cortes de caja', error: error.message });
        }
    });

    // POST /api/cash-cuts - Create new cash cut with automatic calculations
    router.post('/', authenticateToken, async (req, res) => {
        const client = await pool.connect();
        try {
            const { tenantId, branchId: userBranchId, id: employeeId } = req.user;
            const { shiftId, branchId, initialAmount = 0, countedCash, notes, unregisteredWeightEvents = 0, scaleConnectionEvents = 0, cancelledSales = 0 } = req.body;

            const targetBranchId = branchId || userBranchId;

            if (!shiftId) {
                return res.status(400).json({ success: false, message: 'shiftId is required' });
            }

            if (countedCash === undefined || countedCash === null || countedCash < 0) {
                return res.status(400).json({ success: false, message: 'countedCash must be provided and >= 0' });
            }

            await client.query('BEGIN');

            // Get shift details
            const shiftResult = await client.query(
                'SELECT start_time, end_time FROM shifts WHERE id = $1 AND tenant_id = $2',
                [shiftId, tenantId]
            );

            if (shiftResult.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ success: false, message: 'Shift not found' });
            }

            const { start_time: startTime, end_time: endTime } = shiftResult.rows[0];

            // Aggregate cash sales (payment_method = 'cash')
            const cashSalesResult = await client.query(
                `SELECT COALESCE(SUM(total_amount), 0) as total
                 FROM sales
                 WHERE tenant_id = $1 AND branch_id = $2 AND shift_id = $3 AND payment_method = 'cash'
                 AND sale_date >= $4 AND sale_date <= $5`,
                [tenantId, targetBranchId, shiftId, startTime, endTime]
            );

            // Aggregate card sales (payment_method = 'card')
            const cardSalesResult = await client.query(
                `SELECT COALESCE(SUM(total_amount), 0) as total
                 FROM sales
                 WHERE tenant_id = $1 AND branch_id = $2 AND shift_id = $3 AND payment_method = 'card'
                 AND sale_date >= $4 AND sale_date <= $5`,
                [tenantId, targetBranchId, shiftId, startTime, endTime]
            );

            // Aggregate credit sales (payment_method = 'credit')
            const creditSalesResult = await client.query(
                `SELECT COALESCE(SUM(total_amount), 0) as total
                 FROM sales
                 WHERE tenant_id = $1 AND branch_id = $2 AND shift_id = $3 AND payment_method = 'credit'
                 AND sale_date >= $4 AND sale_date <= $5`,
                [tenantId, targetBranchId, shiftId, startTime, endTime]
            );

            // Aggregate cash payments
            const cashPaymentsResult = await client.query(
                `SELECT COALESCE(SUM(total_amount), 0) as total
                 FROM sales
                 WHERE tenant_id = $1 AND branch_id = $2 AND shift_id = $3 AND sale_type = 'payment' AND payment_method = 'cash'
                 AND sale_date >= $4 AND sale_date <= $5`,
                [tenantId, targetBranchId, shiftId, startTime, endTime]
            );

            // Aggregate card payments
            const cardPaymentsResult = await client.query(
                `SELECT COALESCE(SUM(total_amount), 0) as total
                 FROM sales
                 WHERE tenant_id = $1 AND branch_id = $2 AND shift_id = $3 AND sale_type = 'payment' AND payment_method = 'card'
                 AND sale_date >= $4 AND sale_date <= $5`,
                [tenantId, targetBranchId, shiftId, startTime, endTime]
            );

            // Aggregate expenses
            const expensesResult = await client.query(
                `SELECT COALESCE(SUM(amount), 0) as total
                 FROM expenses
                 WHERE tenant_id = $1 AND branch_id = $2 AND shift_id = $3
                 AND expense_date >= $4 AND expense_date <= $5`,
                [tenantId, targetBranchId, shiftId, startTime, endTime]
            );

            // Aggregate deposits
            const depositsResult = await client.query(
                `SELECT COALESCE(SUM(amount), 0) as total
                 FROM deposits
                 WHERE tenant_id = $1 AND branch_id = $2 AND shift_id = $3
                 AND deposit_date >= $4 AND deposit_date <= $5`,
                [tenantId, targetBranchId, shiftId, startTime, endTime]
            );

            // Aggregate withdrawals
            const withdrawalsResult = await client.query(
                `SELECT COALESCE(SUM(amount), 0) as total
                 FROM withdrawals
                 WHERE tenant_id = $1 AND branch_id = $2 AND shift_id = $3
                 AND withdrawal_date >= $4 AND withdrawal_date <= $5`,
                [tenantId, targetBranchId, shiftId, startTime, endTime]
            );

            // Calculate expected cash in drawer
            const totalCashSales = parseFloat(cashSalesResult.rows[0].total);
            const totalCardSales = parseFloat(cardSalesResult.rows[0].total);
            const totalCreditSales = parseFloat(creditSalesResult.rows[0].total);
            const totalCashPayments = parseFloat(cashPaymentsResult.rows[0].total);
            const totalCardPayments = parseFloat(cardPaymentsResult.rows[0].total);
            const totalExpenses = parseFloat(expensesResult.rows[0].total);
            const totalDeposits = parseFloat(depositsResult.rows[0].total);
            const totalWithdrawals = parseFloat(withdrawalsResult.rows[0].total);

            // FORMULA: Initial + Cash Sales + Cash Payments - Expenses - Withdrawals + Deposits
            const expectedCashInDrawer = parseFloat(initialAmount) + totalCashSales + totalCashPayments - totalExpenses - totalWithdrawals + totalDeposits;

            // Calculate difference (discrepancy)
            const numericCountedCash = parseFloat(countedCash);
            const difference = numericCountedCash - expectedCashInDrawer;

            // Insert cash cut record
            const insertResult = await client.query(
                `INSERT INTO cash_cuts (
                    tenant_id, branch_id, shift_id, employee_id,
                    start_time, end_time,
                    initial_amount,
                    total_cash_sales, total_card_sales, total_credit_sales,
                    total_cash_payments, total_card_payments,
                    total_expenses, total_deposits, total_withdrawals,
                    expected_cash_in_drawer, counted_cash, difference,
                    unregistered_weight_events, scale_connection_events, cancelled_sales,
                    notes, is_closed
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
                RETURNING *`,
                [
                    tenantId, targetBranchId, shiftId, employeeId,
                    startTime, endTime,
                    parseFloat(initialAmount),
                    totalCashSales, totalCardSales, totalCreditSales,
                    totalCashPayments, totalCardPayments,
                    totalExpenses, totalDeposits, totalWithdrawals,
                    expectedCashInDrawer, numericCountedCash, difference,
                    unregisteredWeightEvents, scaleConnectionEvents, cancelledSales,
                    notes || null, true
                ]
            );

            await client.query('COMMIT');

            const cashCut = insertResult.rows[0];
            console.log(`[CashCuts] ✅ Cash cut created for shift ${shiftId}, difference: $${difference}`);

            res.json({
                success: true,
                data: {
                    ...cashCut,
                    initial_amount: parseFloat(cashCut.initial_amount),
                    total_cash_sales: parseFloat(cashCut.total_cash_sales),
                    total_card_sales: parseFloat(cashCut.total_card_sales),
                    total_credit_sales: parseFloat(cashCut.total_credit_sales),
                    total_cash_payments: parseFloat(cashCut.total_cash_payments),
                    total_card_payments: parseFloat(cashCut.total_card_payments),
                    total_expenses: parseFloat(cashCut.total_expenses),
                    total_deposits: parseFloat(cashCut.total_deposits),
                    total_withdrawals: parseFloat(cashCut.total_withdrawals),
                    expected_cash_in_drawer: parseFloat(cashCut.expected_cash_in_drawer),
                    counted_cash: parseFloat(cashCut.counted_cash),
                    difference: parseFloat(cashCut.difference),
                    start_time: new Date(cashCut.start_time).toISOString(),
                    end_time: new Date(cashCut.end_time).toISOString(),
                    created_at: new Date(cashCut.created_at).toISOString(),
                    updated_at: new Date(cashCut.updated_at).toISOString()
                }
            });
        } catch (error) {
            await client.query('ROLLBACK');
            console.error('[CashCuts] ❌ Error creating cash cut:', error.message);
            res.status(500).json({ success: false, message: 'Error al crear corte de caja', error: error.message });
        } finally {
            client.release();
        }
    });

    // POST /api/cash-cuts/sync - Sync cash cuts from mobile/desktop
    router.post('/sync', authenticateToken, async (req, res) => {
        try {
            const { tenantId } = req.user;
            const cashCuts = Array.isArray(req.body) ? req.body : [req.body];

            console.log(`[CashCuts/Sync] Syncing ${cashCuts.length} cash cuts for tenant ${tenantId}`);

            const results = [];

            for (const cashCut of cashCuts) {
                const client = await pool.connect();
                try {
                    const {
                        branchId, shiftId, employeeId,
                        initialAmount, totalCashSales, totalCardSales, totalCreditSales,
                        totalCashPayments, totalCardPayments,
                        totalExpenses, totalDeposits, totalWithdrawals,
                        expectedCashInDrawer, countedCash, difference,
                        unregisteredWeightEvents = 0, scaleConnectionEvents = 0, cancelledSales = 0,
                        notes, isClosed = true
                    } = cashCut;

                    if (!shiftId || !branchId || countedCash === undefined) {
                        results.push({ success: false, error: 'Missing required fields (shiftId, branchId, countedCash)' });
                        continue;
                    }

                    await client.query('BEGIN');

                    // Get shift details for time range
                    const shiftResult = await client.query(
                        'SELECT start_time, end_time FROM shifts WHERE id = $1 AND tenant_id = $2',
                        [shiftId, tenantId]
                    );

                    if (shiftResult.rows.length === 0) {
                        await client.query('ROLLBACK');
                        results.push({ success: false, error: 'Shift not found' });
                        continue;
                    }

                    const { start_time: startTime, end_time: endTime } = shiftResult.rows[0];

                    // Insert cash cut record
                    const insertResult = await client.query(
                        `INSERT INTO cash_cuts (
                            tenant_id, branch_id, shift_id, employee_id,
                            start_time, end_time,
                            initial_amount,
                            total_cash_sales, total_card_sales, total_credit_sales,
                            total_cash_payments, total_card_payments,
                            total_expenses, total_deposits, total_withdrawals,
                            expected_cash_in_drawer, counted_cash, difference,
                            unregistered_weight_events, scale_connection_events, cancelled_sales,
                            notes, is_closed
                        )
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
                        RETURNING *`,
                        [
                            tenantId, branchId, shiftId, employeeId || null,
                            startTime, endTime,
                            parseFloat(initialAmount || 0),
                            parseFloat(totalCashSales || 0),
                            parseFloat(totalCardSales || 0),
                            parseFloat(totalCreditSales || 0),
                            parseFloat(totalCashPayments || 0),
                            parseFloat(totalCardPayments || 0),
                            parseFloat(totalExpenses || 0),
                            parseFloat(totalDeposits || 0),
                            parseFloat(totalWithdrawals || 0),
                            parseFloat(expectedCashInDrawer || 0),
                            parseFloat(countedCash),
                            parseFloat(difference || 0),
                            unregisteredWeightEvents,
                            scaleConnectionEvents,
                            cancelledSales,
                            notes || null,
                            isClosed
                        ]
                    );

                    await client.query('COMMIT');

                    results.push({ success: true, data: insertResult.rows[0] });
                    console.log(`[CashCuts/Sync] ✅ Cash cut synced for shift ${shiftId}`);
                } catch (error) {
                    await client.query('ROLLBACK');
                    results.push({ success: false, error: error.message });
                    console.error(`[CashCuts/Sync] ❌ Error:`, error.message);
                } finally {
                    client.release();
                }
            }

            const successCount = results.filter(r => r.success).length;
            res.json({
                success: true,
                message: `${successCount}/${cashCuts.length} cash cuts synced`,
                results
            });
        } catch (error) {
            console.error('[CashCuts/Sync] ❌ Error:', error.message);
            res.status(500).json({ success: false, message: 'Error syncing cash cuts', error: error.message });
        }
    });

    return router;
};
