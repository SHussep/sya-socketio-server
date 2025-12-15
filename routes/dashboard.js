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
            const { branch_id, start_date, end_date, all_branches = 'false', shift_id, timezone } = req.query;

            // Prioridad: 1. branch_id del query, 2. branchId del JWT
            const targetBranchId = branch_id ? parseInt(branch_id) : userBranchId;
            const shouldFilterByBranch = all_branches !== 'true' && targetBranchId;

            // ✅ Prioridad de timezone: 1. timezone del cliente, 2. timezone del branch, 3. default
            let userTimezone = timezone || null;

            // Obtener timezone del branch como fallback
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

            // Usar timezone del cliente si está disponible, sino del branch
            const effectiveTimezone = userTimezone || branchTimezone;

            console.log(`[Dashboard Summary] Client timezone: ${timezone}, Branch timezone: ${branchTimezone}, Using: ${effectiveTimezone}`);
            console.log(`[Dashboard Summary] Date filters - start_date: ${start_date}, end_date: ${end_date}`);

            // Construir filtros de fecha timezone-aware
            // Cuando el cliente NO envía fechas, usamos CURRENT_DATE en el timezone efectivo
            let dateFilter = `DATE(fecha_venta_utc AT TIME ZONE '${effectiveTimezone}') = DATE(NOW() AT TIME ZONE '${effectiveTimezone}')`;
            let expenseDateFilter = `DATE(expense_date AT TIME ZONE '${effectiveTimezone}') = DATE(NOW() AT TIME ZONE '${effectiveTimezone}')`;
            let assignmentDateFilter = `DATE(fecha_asignacion AT TIME ZONE '${effectiveTimezone}') = DATE(NOW() AT TIME ZONE '${effectiveTimezone}')`;

            if (start_date && end_date) {
                // ✅ El cliente envía fechas locales (ej: 2025-12-16T00:00:00.000 = medianoche en SU timezone)
                // Extraemos solo la parte de fecha para comparar en el timezone del cliente
                const startDateOnly = start_date.split('T')[0]; // "2025-12-16"
                const endDateOnly = end_date.split('T')[0];     // "2025-12-16"

                console.log(`[Dashboard Summary] Using date range in ${effectiveTimezone}: ${startDateOnly} to ${endDateOnly}`);

                // ✅ Comparar las fechas en el timezone del cliente usando AT TIME ZONE
                // Esto convierte fecha_venta_utc al timezone del cliente antes de extraer la fecha
                dateFilter = `(fecha_venta_utc AT TIME ZONE '${effectiveTimezone}')::date >= '${startDateOnly}'::date AND (fecha_venta_utc AT TIME ZONE '${effectiveTimezone}')::date <= '${endDateOnly}'::date`;
                expenseDateFilter = `(expense_date AT TIME ZONE '${effectiveTimezone}')::date >= '${startDateOnly}'::date AND (expense_date AT TIME ZONE '${effectiveTimezone}')::date <= '${endDateOnly}'::date`;
                assignmentDateFilter = `(fecha_asignacion AT TIME ZONE '${effectiveTimezone}')::date >= '${startDateOnly}'::date AND (fecha_asignacion AT TIME ZONE '${effectiveTimezone}')::date <= '${endDateOnly}'::date`;
            }

            // Total de ventas
            // ✅ FILTRAR solo ventas COMPLETADAS (estado 3) y LIQUIDADAS (estado 5)
            // - Excluye estado 1 = Borrador (sin ticket válido)
            // - Excluye estado 2 = Asignada (repartidor, no es venta final)
            // ✅ IMPORTANTE: Para ventas liquidadas (repartidor), usar fecha_liquidacion_utc
            //    Así aparecen en el día que se cobró, no el día que se asignó
            let salesQuery = `SELECT COALESCE(SUM(total), 0) as total FROM ventas WHERE tenant_id = $1 AND (
                (estado_venta_id = 3 AND ${dateFilter})
                OR
                (estado_venta_id = 5 AND ${dateFilter.replace(/fecha_venta_utc/g, 'COALESCE(fecha_liquidacion_utc, fecha_venta_utc)')})
            )`;
            let salesParams = [tenantId];
            let paramIndex = 2;

            if (shouldFilterByBranch) {
                salesQuery += ` AND branch_id = $${paramIndex}`;
                salesParams.push(targetBranchId);
                paramIndex++;
            }

            if (shift_id) {
                salesQuery += ` AND id_turno = $${paramIndex}`;
                salesParams.push(parseInt(shift_id));
                paramIndex++;
            }

            console.log(`[Dashboard Summary] Sales Query: ${salesQuery}`);
            console.log(`[Dashboard Summary] Sales Params: ${JSON.stringify(salesParams)}`);
            const salesResult = await pool.query(salesQuery, salesParams);
            console.log(`[Dashboard Summary] ✅ Total sales: ${salesResult.rows[0].total}`);

            // ═══════════════════════════════════════════════════════════════
            // DESGLOSE DE VENTAS - Por tipo y método de pago
            // ═══════════════════════════════════════════════════════════════
            // ✅ CORREGIDO: Mostrador puede tener estado 3 O 5 (cuando se liquida desde móvil)
            // Repartidor siempre tiene estado 5 (liquidado)
            let breakdownQuery = `
                SELECT
                    -- Por tipo de venta (1=Mostrador, 2=Repartidor)
                    -- Mostrador: puede ser estado 3 (completada) o 5 (liquidada desde móvil)
                    COALESCE(SUM(CASE WHEN venta_tipo_id = 1 AND estado_venta_id IN (3, 5) THEN total ELSE 0 END), 0) as mostrador_total,
                    COALESCE(SUM(CASE WHEN venta_tipo_id = 2 AND estado_venta_id = 5 THEN total ELSE 0 END), 0) as repartidor_liquidado,
                    -- Por método de pago (1=Efectivo, 2=Tarjeta, 3=Crédito)
                    COALESCE(SUM(CASE WHEN tipo_pago_id = 1 AND estado_venta_id IN (3, 5) THEN total ELSE 0 END), 0) as efectivo_total,
                    COALESCE(SUM(CASE WHEN tipo_pago_id = 2 AND estado_venta_id IN (3, 5) THEN total ELSE 0 END), 0) as tarjeta_total,
                    COALESCE(SUM(CASE WHEN tipo_pago_id = 3 AND estado_venta_id IN (3, 5) THEN total ELSE 0 END), 0) as credito_total,
                    -- Conteos
                    COUNT(CASE WHEN venta_tipo_id = 1 AND estado_venta_id IN (3, 5) THEN 1 END) as mostrador_count,
                    COUNT(CASE WHEN venta_tipo_id = 2 AND estado_venta_id = 5 THEN 1 END) as repartidor_count
                FROM ventas
                WHERE tenant_id = $1 AND (
                    (estado_venta_id = 3 AND ${dateFilter})
                    OR
                    (estado_venta_id = 5 AND ${dateFilter.replace(/fecha_venta_utc/g, 'COALESCE(fecha_liquidacion_utc, fecha_venta_utc)')})
                )`;
            let breakdownParams = [tenantId];
            let breakdownParamIndex = 2;

            if (shouldFilterByBranch) {
                breakdownQuery += ` AND branch_id = $${breakdownParamIndex}`;
                breakdownParams.push(targetBranchId);
                breakdownParamIndex++;
            }

            if (shift_id) {
                breakdownQuery += ` AND id_turno = $${breakdownParamIndex}`;
                breakdownParams.push(parseInt(shift_id));
                breakdownParamIndex++;
            }

            console.log(`[Dashboard Summary] Breakdown Query: ${breakdownQuery}`);
            console.log(`[Dashboard Summary] Breakdown Params: ${JSON.stringify(breakdownParams)}`);
            const breakdownResult = await pool.query(breakdownQuery, breakdownParams);
            const breakdown = breakdownResult.rows[0];
            console.log(`[Dashboard Summary] ✅ Breakdown:`, JSON.stringify(breakdown));

            // DEBUG: Ver distribución de venta_tipo_id en ventas del período
            let debugQuery = `
                SELECT
                    venta_tipo_id,
                    estado_venta_id,
                    COUNT(*) as count,
                    COALESCE(SUM(total), 0) as total
                FROM ventas
                WHERE tenant_id = $1 AND (
                    (estado_venta_id = 3 AND ${dateFilter})
                    OR
                    (estado_venta_id = 5 AND ${dateFilter.replace(/fecha_venta_utc/g, 'COALESCE(fecha_liquidacion_utc, fecha_venta_utc)')})
                )`;
            if (shouldFilterByBranch) {
                debugQuery += ` AND branch_id = $2`;
            }
            debugQuery += ` GROUP BY venta_tipo_id, estado_venta_id`;
            const debugResult = await pool.query(debugQuery, shouldFilterByBranch ? [tenantId, targetBranchId] : [tenantId]);
            console.log(`[Dashboard Summary] 🔍 DEBUG venta_tipo_id distribution:`, JSON.stringify(debugResult.rows));

            // Total de gastos
            let expensesQuery = `SELECT COALESCE(SUM(amount), 0) as total FROM expenses WHERE tenant_id = $1 AND ${expenseDateFilter}`;
            let expensesParams = [tenantId];
            let expParamIndex = 2;

            if (shouldFilterByBranch) {
                expensesQuery += ` AND branch_id = $${expParamIndex}`;
                expensesParams.push(targetBranchId);
                expParamIndex++;
            }

            if (shift_id) {
                expensesQuery += ` AND id_turno = $${expParamIndex}`;
                expensesParams.push(parseInt(shift_id));
                expParamIndex++;
            }

            console.log(`[Dashboard Summary] Expenses Query: ${expensesQuery}`);
            console.log(`[Dashboard Summary] Expenses Params: ${JSON.stringify(expensesParams)}`);
            const expensesResult = await pool.query(expensesQuery, expensesParams);
            console.log(`[Dashboard Summary] ✅ Total expenses: ${expensesResult.rows[0].total}`);

            // Último corte de caja
            let cashCutQuery = `SELECT counted_cash FROM cash_cuts WHERE tenant_id = $1`;
            let cashCutParams = [tenantId];
            if (shouldFilterByBranch) {
                cashCutQuery += ` AND branch_id = $2`;
                cashCutParams.push(targetBranchId);
            }
            cashCutQuery += ` ORDER BY cut_date DESC LIMIT 1`;
            const cashCutResult = await pool.query(cashCutQuery, cashCutParams);

            // Eventos Guardian - NO hay tabla guardian_events, los eventos se guardan como agregados en cash_cuts
            // Por ahora, retornar 0 eventos
            const guardianEventsResult = { rows: [{ count: 0 }] };
            console.log(`[Dashboard Summary] ⚠️ Guardian events no implementado (tabla no existe) - retornando 0`);

            // Asignaciones de repartidores (activas: pending + in_progress)
            // ✅ Usar created_at que es más confiable que fecha_asignacion
            let assignmentDateFilterFixed = assignmentDateFilter.replace(/fecha_asignacion/g, 'created_at');
            let assignmentsQuery = `
                SELECT
                    COUNT(*) as total_assignments,
                    COUNT(CASE WHEN status IN ('pending', 'in_progress') THEN 1 END) as active_assignments,
                    COALESCE(SUM(CASE WHEN status IN ('pending', 'in_progress') THEN assigned_amount ELSE 0 END), 0) as active_amount
                FROM repartidor_assignments
                WHERE tenant_id = $1 AND ${assignmentDateFilterFixed}`;
            let assignmentsParams = [tenantId];
            let assignParamIndex = 2;

            if (shouldFilterByBranch) {
                assignmentsQuery += ` AND branch_id = $${assignParamIndex}`;
                assignmentsParams.push(targetBranchId);
                assignParamIndex++;
            }

            if (shift_id) {
                assignmentsQuery += ` AND shift_id = $${assignParamIndex}`;
                assignmentsParams.push(parseInt(shift_id));
                assignParamIndex++;
            }

            console.log(`[Dashboard Summary] Assignments Query: ${assignmentsQuery}`);
            console.log(`[Dashboard Summary] Assignments Params: ${JSON.stringify(assignmentsParams)}`);
            const assignmentsResult = await pool.query(assignmentsQuery, assignmentsParams);
            console.log(`[Dashboard Summary] ✅ Assignments result:`, assignmentsResult.rows[0]);

            console.log(`[Dashboard Summary] Fetching summary - Tenant: ${tenantId}, Branch: ${targetBranchId}, Shift: ${shift_id || 'ALL'}, all_branches: ${all_branches}`);

            res.json({
                success: true,
                data: {
                    totalSales: parseFloat(salesResult.rows[0].total),
                    totalExpenses: parseFloat(expensesResult.rows[0].total),
                    cashInDrawer: cashCutResult.rows.length > 0 ? parseFloat(cashCutResult.rows[0].counted_cash) : 0,
                    unreadGuardianEvents: parseInt(guardianEventsResult.rows[0].count),
                    totalAssignments: parseInt(assignmentsResult.rows[0].total_assignments),
                    activeAssignments: parseInt(assignmentsResult.rows[0].active_assignments),
                    activeAssignmentsAmount: parseFloat(assignmentsResult.rows[0].active_amount),
                    // ✅ NUEVO: Desglose de ventas
                    salesBreakdown: {
                        // Por tipo de venta
                        mostradorTotal: parseFloat(breakdown.mostrador_total),
                        mostradorCount: parseInt(breakdown.mostrador_count),
                        repartidorLiquidado: parseFloat(breakdown.repartidor_liquidado),
                        repartidorCount: parseInt(breakdown.repartidor_count),
                        // Por método de pago
                        efectivoTotal: parseFloat(breakdown.efectivo_total),
                        tarjetaTotal: parseFloat(breakdown.tarjeta_total),
                        creditoTotal: parseFloat(breakdown.credito_total)
                    }
                }
            });
        } catch (error) {
            console.error('[Dashboard Summary] Error:', error);
            res.status(500).json({ success: false, message: 'Error al obtener resumen' });
        }
    });

    return router;
};
