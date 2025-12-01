/**
 * Sync Diagnostics API
 * Endpoint para obtener conteos de registros por entidad (debug/diagnóstico)
 * Permite comparar registros locales (SQLite) vs PostgreSQL
 */

const express = require('express');
const router = express.Router();

module.exports = (pool) => {

    // GET /api/sync-diagnostics/counts/:tenantId/:branchId
    // Obtiene conteos de todas las entidades sincronizables para un tenant/branch
    router.get('/counts/:tenantId/:branchId', async (req, res) => {
        const { tenantId, branchId } = req.params;

        try {
            console.log(`[SyncDiagnostics] 📊 Obteniendo conteos para tenant=${tenantId}, branch=${branchId}`);

            const counts = {};

            // Ventas (solo de esta sucursal)
            const salesResult = await pool.query(
                'SELECT COUNT(*) as count FROM ventas WHERE tenant_id = $1 AND branch_id = $2',
                [tenantId, branchId]
            );
            counts.sales = parseInt(salesResult.rows[0].count);

            // Gastos (solo de esta sucursal)
            const expensesResult = await pool.query(
                'SELECT COUNT(*) as count FROM expenses WHERE tenant_id = $1 AND branch_id = $2',
                [tenantId, branchId]
            );
            counts.expenses = parseInt(expensesResult.rows[0].count);

            // Cortes de caja (solo de esta sucursal)
            const cashCutsResult = await pool.query(
                'SELECT COUNT(*) as count FROM cash_cuts WHERE tenant_id = $1 AND branch_id = $2',
                [tenantId, branchId]
            );
            counts.cashCuts = parseInt(cashCutsResult.rows[0].count);

            // Depósitos (solo de esta sucursal)
            const depositsResult = await pool.query(
                'SELECT COUNT(*) as count FROM deposits WHERE tenant_id = $1 AND branch_id = $2',
                [tenantId, branchId]
            );
            counts.deposits = parseInt(depositsResult.rows[0].count);

            // Retiros (solo de esta sucursal)
            const withdrawalsResult = await pool.query(
                'SELECT COUNT(*) as count FROM withdrawals WHERE tenant_id = $1 AND branch_id = $2',
                [tenantId, branchId]
            );
            counts.withdrawals = parseInt(withdrawalsResult.rows[0].count);

            // Turnos (solo de esta sucursal)
            const shiftsResult = await pool.query(
                'SELECT COUNT(*) as count FROM shifts WHERE tenant_id = $1 AND branch_id = $2',
                [tenantId, branchId]
            );
            counts.shifts = parseInt(shiftsResult.rows[0].count);

            // Pagos de crédito (solo de esta sucursal)
            const creditPaymentsResult = await pool.query(
                'SELECT COUNT(*) as count FROM credit_payments WHERE tenant_id = $1 AND branch_id = $2',
                [tenantId, branchId]
            );
            counts.creditPayments = parseInt(creditPaymentsResult.rows[0].count);

            // Clientes (todo el tenant, no por sucursal)
            // Excluir cliente genérico del sistema (is_system_generic = TRUE)
            const customersResult = await pool.query(
                'SELECT COUNT(*) as count FROM customers WHERE tenant_id = $1 AND (is_system_generic = FALSE OR is_system_generic IS NULL)',
                [tenantId]
            );
            counts.customers = parseInt(customersResult.rows[0].count);

            // Empleados (todo el tenant)
            const employeesResult = await pool.query(
                'SELECT COUNT(*) as count FROM employees WHERE tenant_id = $1',
                [tenantId]
            );
            counts.employees = parseInt(employeesResult.rows[0].count);

            // Asignaciones de repartidor (solo de esta sucursal)
            const assignmentsResult = await pool.query(
                'SELECT COUNT(*) as count FROM repartidor_assignments WHERE tenant_id = $1 AND branch_id = $2',
                [tenantId, branchId]
            );
            counts.repartidorAssignments = parseInt(assignmentsResult.rows[0].count);

            // Devoluciones de repartidor (solo de esta sucursal)
            const returnsResult = await pool.query(
                'SELECT COUNT(*) as count FROM repartidor_returns WHERE tenant_id = $1 AND branch_id = $2',
                [tenantId, branchId]
            );
            counts.repartidorReturns = parseInt(returnsResult.rows[0].count);

            // Guardian logs (solo de esta sucursal)
            const guardianLogsResult = await pool.query(
                'SELECT COUNT(*) as count FROM suspicious_weighing_logs WHERE tenant_id = $1 AND branch_id = $2',
                [tenantId, branchId]
            );
            counts.guardianLogs = parseInt(guardianLogsResult.rows[0].count);

            // Scale disconnection logs (solo de esta sucursal)
            const scaleLogsResult = await pool.query(
                'SELECT COUNT(*) as count FROM scale_disconnection_logs WHERE tenant_id = $1 AND branch_id = $2',
                [tenantId, branchId]
            );
            counts.scaleDisconnectionLogs = parseInt(scaleLogsResult.rows[0].count);

            // Cancelaciones (solo de esta sucursal)
            const cancelacionesResult = await pool.query(
                'SELECT COUNT(*) as count FROM cancelaciones_bitacora WHERE tenant_id = $1 AND branch_id = $2',
                [tenantId, branchId]
            );
            counts.cancelaciones = parseInt(cancelacionesResult.rows[0].count);

            console.log(`[SyncDiagnostics] ✅ Conteos obtenidos:`, counts);

            res.json({
                success: true,
                data: counts,
                timestamp: new Date().toISOString()
            });

        } catch (error) {
            console.error('[SyncDiagnostics] ❌ Error:', error.message);
            res.status(500).json({
                success: false,
                message: 'Error obteniendo conteos',
                error: error.message
            });
        }
    });

    return router;
};
