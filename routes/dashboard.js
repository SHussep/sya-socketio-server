// ═══════════════════════════════════════════════════════════════
// DASHBOARD ROUTES - Extracted from server.js
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

    // GET /api/dashboard/summary - Resumen del dashboard
    router.get('/summary', authenticateToken, async (req, res) => {
        try {
            const { tenantId, branchId: userBranchId } = req.user;
            const { branch_id, start_date, end_date, all_branches = 'false' } = req.query;

            // Prioridad: 1. branch_id del query, 2. branchId del JWT
            const targetBranchId = branch_id ? parseInt(branch_id) : userBranchId;
            const shouldFilterByBranch = all_branches !== 'true' && targetBranchId;

            // Obtener timezone del branch (cada sucursal puede estar en zona horaria diferente)
            let branchTimezone = 'America/Mexico_City'; // Default
            if (targetBranchId) {
                const branchInfo = await pool.query(
                    'SELECT timezone FROM branches WHERE id = $1',
                    [targetBranchId]
                );
                if (branchInfo.rows.length > 0 && branchInfo.rows[0].timezone) {
                    branchTimezone = branchInfo.rows[0].timezone;
                }
            }

            console.log(`[Dashboard Summary] Using timezone: ${branchTimezone} for branch ${targetBranchId}`);
            console.log(`[Dashboard Summary] Date filters - start_date: ${start_date}, end_date: ${end_date}`);

            // Construir filtros de fecha timezone-aware usando el timezone del branch
            // Las columnas ahora son TIMESTAMP WITH TIME ZONE
            // Cuando el cliente NO envía fechas, usamos CURRENT_DATE en el timezone del branch
            let dateFilter = `DATE(sale_date AT TIME ZONE '${branchTimezone}') = DATE(NOW() AT TIME ZONE '${branchTimezone}')`;
            let expenseDateFilter = `DATE(expense_date AT TIME ZONE '${branchTimezone}') = DATE(NOW() AT TIME ZONE '${branchTimezone}')`;

            if (start_date && end_date) {
                // El cliente envía timestamps ISO (ej: 2025-10-21T00:00:00.000Z)
                // Necesitamos asegurar que end_date sea el final del día
                const startDateTime = new Date(start_date);
                const endDateTime = new Date(end_date);

                // Si end_date viene a las 00:00:00, cambiar a 23:59:59.999Z del mismo día
                if (endDateTime.getHours() === 0 && endDateTime.getMinutes() === 0) {
                    endDateTime.setDate(endDateTime.getDate() + 1);
                    endDateTime.setMilliseconds(-1);
                }

                const startDateISO = startDateTime.toISOString();
                const endDateISO = endDateTime.toISOString();

                console.log(`[Dashboard Summary] Converted dates - start: ${startDateISO}, end: ${endDateISO}`);

                // PostgreSQL maneja automáticamente la conversión de timezone para timestamptz
                dateFilter = `sale_date >= '${startDateISO}'::timestamptz AND sale_date < '${endDateISO}'::timestamptz`;
                expenseDateFilter = `expense_date >= '${startDateISO}'::timestamptz AND expense_date < '${endDateISO}'::timestamptz`;
            }

            // Total de ventas
            let salesQuery = `SELECT COALESCE(SUM(total_amount), 0) as total FROM sales WHERE tenant_id = $1 AND ${dateFilter}`;
            let salesParams = [tenantId];
            if (shouldFilterByBranch) {
                salesQuery += ` AND branch_id = $2`;
                salesParams.push(targetBranchId);
            }
            console.log(`[Dashboard Summary] Sales Query: ${salesQuery}`);
            console.log(`[Dashboard Summary] Sales Params: ${JSON.stringify(salesParams)}`);
            const salesResult = await pool.query(salesQuery, salesParams);
            console.log(`[Dashboard Summary] ✅ Total sales: ${salesResult.rows[0].total}`);

            // Total de gastos
            let expensesQuery = `SELECT COALESCE(SUM(amount), 0) as total FROM expenses WHERE tenant_id = $1 AND ${expenseDateFilter}`;
            let expensesParams = [tenantId];
            if (shouldFilterByBranch) {
                expensesQuery += ` AND branch_id = $2`;
                expensesParams.push(targetBranchId);
            }
            const expensesResult = await pool.query(expensesQuery, expensesParams);

            // Último corte de caja
            let cashCutQuery = `SELECT cash_in_drawer FROM cash_cuts WHERE tenant_id = $1`;
            let cashCutParams = [tenantId];
            if (shouldFilterByBranch) {
                cashCutQuery += ` AND branch_id = $2`;
                cashCutParams.push(targetBranchId);
            }
            cashCutQuery += ` ORDER BY cut_date DESC LIMIT 1`;
            const cashCutResult = await pool.query(cashCutQuery, cashCutParams);

            // Eventos Guardian no leídos
            let guardianQuery = `SELECT COUNT(*) as count FROM guardian_events WHERE tenant_id = $1 AND is_read = false`;
            let guardianParams = [tenantId];
            if (shouldFilterByBranch) {
                guardianQuery += ` AND branch_id = $2`;
                guardianParams.push(targetBranchId);
            }
            const guardianEventsResult = await pool.query(guardianQuery, guardianParams);

            console.log(`[Dashboard Summary] Fetching summary - Tenant: ${tenantId}, Branch: ${targetBranchId}, all_branches: ${all_branches}`);

            res.json({
                success: true,
                data: {
                    totalSales: parseFloat(salesResult.rows[0].total),
                    totalExpenses: parseFloat(expensesResult.rows[0].total),
                    cashInDrawer: cashCutResult.rows.length > 0 ? parseFloat(cashCutResult.rows[0].cash_in_drawer) : 0,
                    unreadGuardianEvents: parseInt(guardianEventsResult.rows[0].count)
                }
            });
        } catch (error) {
            console.error('[Dashboard Summary] Error:', error);
            res.status(500).json({ success: false, message: 'Error al obtener resumen' });
        }
    });

    return router;
};
