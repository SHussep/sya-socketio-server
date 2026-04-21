// ═══════════════════════════════════════════════════════════════
// TENANT SNAPSHOT ROUTES
// ═══════════════════════════════════════════════════════════════
//
// Devuelve al cliente autenticado una "foto" compacta de los GlobalIds
// de su propio tenant/branch en Postgres. Usada por la herramienta
// "Diagnóstico y Reparación" del cliente WinUI para comparar contra su
// BD local y detectar divergencias.
//
// Diseño read-only, seguro: el tenant/branch vienen del JWT, no del query.
// No hay forma de consultar otro tenant sin ser ese tenant.

const express = require('express');
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET;

function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) {
        return res.status(401).json({ success: false, message: 'Token no proporcionado' });
    }
    jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }, (err, user) => {
        if (err) {
            return res.status(403).json({ success: false, message: 'Token inválido o expirado' });
        }
        req.user = user;
        next();
    });
}

module.exports = (pool) => {
    const router = express.Router();

    // GET /api/tenant-snapshot/mine
    //
    // Respuesta:
    //   {
    //     tenantId, branchId, branchName, generatedAt,
    //     entitiesGlobalIds: { ventas: [uuid,...], expenses: [...], ... },
    //     entitiesMeta: { ventas: [{global_id, estado_venta_id, total}], ... }
    //   }
    router.get('/mine', authenticateToken, async (req, res) => {
        const { tenantId, branchId } = req.user || {};
        if (!tenantId || !branchId) {
            return res.status(400).json({
                success: false,
                message: 'Token no tiene tenantId/branchId válidos'
            });
        }

        const client = await pool.connect();
        try {
            // Metadata de la sucursal (para mostrar nombre en UI del Doctor)
            const branchInfo = await client.query(
                `SELECT b.name AS branch_name, t.business_name AS tenant_name
                   FROM branches b
                   JOIN tenants t ON t.id = b.tenant_id
                  WHERE b.id = $1 AND b.tenant_id = $2`,
                [branchId, tenantId]
            );
            const branchName = branchInfo.rows[0]?.branch_name || null;
            const tenantName = branchInfo.rows[0]?.tenant_name || null;

            // ───────────────────────────────────────────────────────
            // Helper: ejecutar query y devolver arrays de global_ids + meta
            // ───────────────────────────────────────────────────────
            async function fetchEntity(name, sql, params, metaMapper) {
                try {
                    const r = await client.query(sql, params);
                    const ids = r.rows.map(row => row.global_id).filter(Boolean);
                    const meta = metaMapper ? r.rows.map(metaMapper) : null;
                    return { ids, meta };
                } catch (err) {
                    console.warn(`[tenant-snapshot] ${name} skipped:`, err.message);
                    return { ids: [], meta: null };
                }
            }

            // ───────────────────────────────────────────────────────
            // Entidades branch-scoped (tenant_id + branch_id)
            // ───────────────────────────────────────────────────────
            const ventas = await fetchEntity(
                'ventas',
                `SELECT global_id, estado_venta_id, total::text AS total
                   FROM ventas WHERE tenant_id = $1 AND branch_id = $2`,
                [tenantId, branchId],
                r => ({ global_id: r.global_id, estado_venta_id: r.estado_venta_id, total: r.total })
            );

            const expenses = await fetchEntity(
                'expenses',
                `SELECT global_id, status FROM expenses WHERE tenant_id = $1 AND branch_id = $2`,
                [tenantId, branchId],
                r => ({ global_id: r.global_id, status: r.status })
            );

            const cashCuts = await fetchEntity(
                'cash_cuts',
                `SELECT global_id, is_closed, shift_id FROM cash_cuts WHERE tenant_id = $1 AND branch_id = $2`,
                [tenantId, branchId],
                r => ({ global_id: r.global_id, is_closed: r.is_closed, shift_id: r.shift_id })
            );

            const shifts = await fetchEntity(
                'shifts',
                `SELECT global_id, is_closed, employee_id FROM shifts WHERE tenant_id = $1 AND branch_id = $2`,
                [tenantId, branchId],
                r => ({ global_id: r.global_id, is_closed: r.is_closed, employee_id: r.employee_id })
            );

            const deposits = await fetchEntity(
                'deposits',
                `SELECT global_id FROM deposits WHERE tenant_id = $1 AND branch_id = $2`,
                [tenantId, branchId]
            );

            const withdrawals = await fetchEntity(
                'withdrawals',
                `SELECT global_id FROM withdrawals WHERE tenant_id = $1 AND branch_id = $2`,
                [tenantId, branchId]
            );

            const creditPayments = await fetchEntity(
                'credit_payments',
                `SELECT global_id FROM credit_payments WHERE tenant_id = $1 AND branch_id = $2`,
                [tenantId, branchId]
            );

            const repartidorAssignments = await fetchEntity(
                'repartidor_assignments',
                `SELECT global_id, status FROM repartidor_assignments WHERE tenant_id = $1 AND branch_id = $2`,
                [tenantId, branchId],
                r => ({ global_id: r.global_id, status: r.status })
            );

            const repartidorReturns = await fetchEntity(
                'repartidor_returns',
                `SELECT global_id FROM repartidor_returns WHERE tenant_id = $1 AND branch_id = $2`,
                [tenantId, branchId]
            );

            const guardianLogs = await fetchEntity(
                'suspicious_weighing_logs',
                `SELECT global_id FROM suspicious_weighing_logs WHERE tenant_id = $1 AND branch_id = $2`,
                [tenantId, branchId]
            );

            const scaleDisconnectionLogs = await fetchEntity(
                'scale_disconnection_logs',
                `SELECT global_id FROM scale_disconnection_logs WHERE tenant_id = $1 AND branch_id = $2`,
                [tenantId, branchId]
            );

            const employeeDailyMetrics = await fetchEntity(
                'employee_daily_metrics',
                `SELECT global_id FROM employee_daily_metrics WHERE tenant_id = $1 AND branch_id = $2`,
                [tenantId, branchId]
            );

            const preparationModeLogs = await fetchEntity(
                'preparation_mode_logs',
                `SELECT global_id FROM preparation_mode_logs WHERE tenant_id = $1 AND branch_id = $2`,
                [tenantId, branchId]
            );

            const cancelacionesBitacora = await fetchEntity(
                'cancelaciones_bitacora',
                `SELECT global_id FROM cancelaciones_bitacora WHERE tenant_id = $1 AND branch_id = $2`,
                [tenantId, branchId]
            );

            const notasCredito = await fetchEntity(
                'notas_credito',
                `SELECT global_id FROM notas_credito WHERE tenant_id = $1 AND branch_id = $2`,
                [tenantId, branchId]
            );

            const purchases = await fetchEntity(
                'purchases',
                `SELECT global_id FROM purchases WHERE tenant_id = $1 AND branch_id = $2`,
                [tenantId, branchId]
            );

            const employeeDebts = await fetchEntity(
                'employee_debts',
                `SELECT global_id FROM employee_debts WHERE tenant_id = $1 AND branch_id = $2`,
                [tenantId, branchId]
            );

            const kardexEntries = await fetchEntity(
                'kardex_entries',
                `SELECT global_id FROM kardex_entries WHERE tenant_id = $1 AND branch_id = $2`,
                [tenantId, branchId]
            );

            // ───────────────────────────────────────────────────────
            // Entidades tenant-scoped (sin branch_id)
            // ───────────────────────────────────────────────────────
            const customers = await fetchEntity(
                'customers',
                `SELECT global_id FROM customers
                  WHERE tenant_id = $1 AND (is_system_generic = FALSE OR is_system_generic IS NULL)`,
                [tenantId]
            );

            const employees = await fetchEntity(
                'employees',
                `SELECT global_id FROM employees WHERE tenant_id = $1`,
                [tenantId]
            );

            const productos = await fetchEntity(
                'productos',
                `SELECT global_id FROM productos WHERE tenant_id = $1`,
                [tenantId]
            );

            const productCategories = await fetchEntity(
                'product_categories',
                `SELECT global_id FROM product_categories WHERE tenant_id = $1`,
                [tenantId]
            );

            const suppliers = await fetchEntity(
                'suppliers',
                `SELECT global_id FROM suppliers WHERE tenant_id = $1`,
                [tenantId]
            );

            // ───────────────────────────────────────────────────────
            // Respuesta
            // ───────────────────────────────────────────────────────
            const entitiesGlobalIds = {
                ventas: ventas.ids,
                expenses: expenses.ids,
                cash_cuts: cashCuts.ids,
                shifts: shifts.ids,
                deposits: deposits.ids,
                withdrawals: withdrawals.ids,
                credit_payments: creditPayments.ids,
                repartidor_assignments: repartidorAssignments.ids,
                repartidor_returns: repartidorReturns.ids,
                suspicious_weighing_logs: guardianLogs.ids,
                scale_disconnection_logs: scaleDisconnectionLogs.ids,
                employee_daily_metrics: employeeDailyMetrics.ids,
                preparation_mode_logs: preparationModeLogs.ids,
                cancelaciones_bitacora: cancelacionesBitacora.ids,
                notas_credito: notasCredito.ids,
                purchases: purchases.ids,
                employee_debts: employeeDebts.ids,
                kardex_entries: kardexEntries.ids,
                customers: customers.ids,
                employees: employees.ids,
                productos: productos.ids,
                product_categories: productCategories.ids,
                suppliers: suppliers.ids,
            };

            const entitiesMeta = {};
            if (ventas.meta) entitiesMeta.ventas = ventas.meta;
            if (expenses.meta) entitiesMeta.expenses = expenses.meta;
            if (cashCuts.meta) entitiesMeta.cash_cuts = cashCuts.meta;
            if (shifts.meta) entitiesMeta.shifts = shifts.meta;
            if (repartidorAssignments.meta) entitiesMeta.repartidor_assignments = repartidorAssignments.meta;

            res.json({
                success: true,
                tenantId,
                branchId,
                branchName,
                tenantName,
                generatedAt: new Date().toISOString(),
                entitiesGlobalIds,
                entitiesMeta,
            });
        } catch (err) {
            console.error('[tenant-snapshot/mine] ERROR:', err);
            res.status(500).json({ success: false, message: 'snapshot_failed', detail: err.message });
        } finally {
            client.release();
        }
    });

    return router;
};
