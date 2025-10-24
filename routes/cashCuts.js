// ═══════════════════════════════════════════════════════════════
// CASH CUTS ROUTES - Extracted from server.js
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

    // GET /api/cash-cuts - Lista de cortes de caja
    router.get('/', authenticateToken, async (req, res) => {
        try {
            const { tenantId } = req.user;
            const { limit = 50, offset = 0 } = req.query;

            const result = await pool.query(
                `SELECT c.id, c.cut_number, c.total_sales, c.total_expenses, c.cash_in_drawer,
                        c.expected_cash, c.difference, c.cut_date,
                        e.full_name as employee_name, b.name as branch_name
                 FROM cash_cuts c
                 LEFT JOIN employees e ON c.employee_id = e.id
                 LEFT JOIN branches b ON c.branch_id = b.id
                 WHERE c.tenant_id = $1
                 ORDER BY c.cut_date DESC
                 LIMIT $2 OFFSET $3`,
                [tenantId, limit, offset]
            );

            res.json({
                success: true,
                data: result.rows
            });
        } catch (error) {
            console.error('[Cash Cuts] Error:', error);
            res.status(500).json({ success: false, message: 'Error al obtener cortes de caja' });
        }
    });

    // POST /api/cash-cuts - Crear corte de caja (desde Desktop)
    router.post('/', authenticateToken, async (req, res) => {
        try {
            const { tenantId, employeeId } = req.user;
            const { branchId, cutNumber, totalSales, totalExpenses, cashInDrawer, expectedCash, difference } = req.body;

            const result = await pool.query(
                `INSERT INTO cash_cuts (tenant_id, branch_id, employee_id, cut_number, total_sales, total_expenses, cash_in_drawer, expected_cash, difference)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                 RETURNING *`,
                [tenantId, branchId, employeeId, cutNumber, totalSales, totalExpenses, cashInDrawer, expectedCash, difference]
            );

            console.log(`[Cash Cuts] ✅ Corte creado: ${cutNumber}`);
            res.json({ success: true, data: result.rows[0] });
        } catch (error) {
            console.error('[Cash Cuts] Error:', error);
            res.status(500).json({ success: false, message: 'Error al crear corte de caja' });
        }
    });

    // POST /api/sync/cash-cuts - Alias de /api/cash-cuts (para compatibilidad con Desktop)
    router.post('/sync', async (req, res) => {
        try {
            const { tenantId, branchId, employeeId, cutNumber, totalSales, totalExpenses, cashInDrawer, expectedCash, difference, cutDate, userEmail } = req.body;

            console.log(`[Sync/CashCuts] Desktop sync - Tenant: ${tenantId}, Branch: ${branchId}, Cut: ${cutNumber}, Date: ${cutDate}`);

            if (!tenantId || !branchId || !cutNumber) {
                return res.status(400).json({ success: false, message: 'Datos incompletos (tenantId, branchId, cutNumber requeridos)' });
            }

            // Usar employeeId del body si viene, sino buscar por email
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

            // Usar cutDate del body, o si viene null, usar la fecha actual en UTC
            const finalCutDate = cutDate || new Date().toISOString();

            const result = await pool.query(
                `INSERT INTO cash_cuts (tenant_id, branch_id, employee_id, cut_number, total_sales, total_expenses, cash_in_drawer, expected_cash, difference, cut_date)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                 RETURNING *`,
                [tenantId, branchId, finalEmployeeId, cutNumber, totalSales || 0, totalExpenses || 0, cashInDrawer || 0, expectedCash || 0, difference || 0, finalCutDate]
            );

            console.log(`[Sync/CashCuts] ✅ Corte sincronizado: ${cutNumber} - cut_date: ${finalCutDate}`);
            res.json({ success: true, data: result.rows[0] });
        } catch (error) {
            console.error('[Sync/CashCuts] Error:', error);
            res.status(500).json({ success: false, message: 'Error al sincronizar corte', error: error.message });
        }
    });

    return router;
};
