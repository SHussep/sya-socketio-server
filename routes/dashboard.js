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
            // Todas las columnas de fecha son ahora 'timestamp with time zone' (timestamptz)
            let dateFilter = `DATE(fecha_venta_utc AT TIME ZONE '${effectiveTimezone}') = DATE(NOW() AT TIME ZONE '${effectiveTimezone}')`;
            let expenseDateFilter = `DATE(expense_date AT TIME ZONE '${effectiveTimezone}') = DATE(NOW() AT TIME ZONE '${effectiveTimezone}')`;
            let assignmentDateFilter = `DATE(fecha_asignacion AT TIME ZONE '${effectiveTimezone}') = DATE(NOW() AT TIME ZONE '${effectiveTimezone}')`;
            let guardianDateFilter = `DATE(event_date AT TIME ZONE '${effectiveTimezone}') = DATE(NOW() AT TIME ZONE '${effectiveTimezone}')`;

            if (start_date && end_date) {
                // El cliente envía fechas locales (ej: 2025-12-16T00:00:00.000 = medianoche en SU timezone)
                // Extraemos solo la parte de fecha para comparar en el timezone del cliente
                const startDateOnly = start_date.split('T')[0]; // "2025-12-16"
                const endDateOnly = end_date.split('T')[0];     // "2025-12-16"

                console.log(`[Dashboard Summary] Using date range in ${effectiveTimezone}: ${startDateOnly} to ${endDateOnly}`);

                // Comparar las fechas en el timezone del cliente usando AT TIME ZONE
                dateFilter = `(fecha_venta_utc AT TIME ZONE '${effectiveTimezone}')::date >= '${startDateOnly}'::date AND (fecha_venta_utc AT TIME ZONE '${effectiveTimezone}')::date <= '${endDateOnly}'::date`;
                expenseDateFilter = `(expense_date AT TIME ZONE '${effectiveTimezone}')::date >= '${startDateOnly}'::date AND (expense_date AT TIME ZONE '${effectiveTimezone}')::date <= '${endDateOnly}'::date`;
                assignmentDateFilter = `(fecha_asignacion AT TIME ZONE '${effectiveTimezone}')::date >= '${startDateOnly}'::date AND (fecha_asignacion AT TIME ZONE '${effectiveTimezone}')::date <= '${endDateOnly}'::date`;
                guardianDateFilter = `(event_date AT TIME ZONE '${effectiveTimezone}')::date >= '${startDateOnly}'::date AND (event_date AT TIME ZONE '${effectiveTimezone}')::date <= '${endDateOnly}'::date`;
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
            // 🔧 FIX: Para pagos MIXTOS (tipo_pago_id=4), obtener desglose de repartidor_assignments
            // 🔧 SIMPLIFICADO: Ahora ventas tiene cash_amount, card_amount, credit_amount directamente
            let breakdownQuery = `
                SELECT
                    -- Por tipo de venta (1=Mostrador, 2=Repartidor)
                    -- Mostrador: puede ser estado 3 (completada) o 5 (liquidada desde móvil)
                    COALESCE(SUM(CASE WHEN v.venta_tipo_id = 1 AND v.estado_venta_id IN (3, 5) THEN v.total ELSE 0 END), 0) as mostrador_total,
                    COALESCE(SUM(CASE WHEN v.venta_tipo_id = 2 AND v.estado_venta_id = 5 THEN v.total ELSE 0 END), 0) as repartidor_liquidado,
                    -- Por método de pago: usar las columnas directas de ventas
                    COALESCE(SUM(CASE WHEN v.estado_venta_id IN (3, 5) THEN COALESCE(v.cash_amount, 0) ELSE 0 END), 0) as efectivo_total,
                    COALESCE(SUM(CASE WHEN v.estado_venta_id IN (3, 5) THEN COALESCE(v.card_amount, 0) ELSE 0 END), 0) as tarjeta_total,
                    COALESCE(SUM(CASE WHEN v.estado_venta_id IN (3, 5) THEN COALESCE(v.credit_amount, 0) ELSE 0 END), 0) as credito_total,
                    -- Conteos
                    COUNT(CASE WHEN v.venta_tipo_id = 1 AND v.estado_venta_id IN (3, 5) THEN 1 END) as mostrador_count,
                    COUNT(CASE WHEN v.venta_tipo_id = 2 AND v.estado_venta_id = 5 THEN 1 END) as repartidor_count
                FROM ventas v
                WHERE v.tenant_id = $1 AND (
                    (v.estado_venta_id = 3 AND ${dateFilter.replace(/fecha_venta_utc/g, 'v.fecha_venta_utc')})
                    OR
                    (v.estado_venta_id = 5 AND ${dateFilter.replace(/fecha_venta_utc/g, 'COALESCE(v.fecha_liquidacion_utc, v.fecha_venta_utc)')})
                )`;
            let breakdownParams = [tenantId];
            let breakdownParamIndex = 2;

            if (shouldFilterByBranch) {
                breakdownQuery += ` AND v.branch_id = $${breakdownParamIndex}`;
                breakdownParams.push(targetBranchId);
                breakdownParamIndex++;
            }

            if (shift_id) {
                breakdownQuery += ` AND v.id_turno = $${breakdownParamIndex}`;
                breakdownParams.push(parseInt(shift_id));
                breakdownParamIndex++;
            }

            console.log(`[Dashboard Summary] Breakdown Query: ${breakdownQuery}`);
            console.log(`[Dashboard Summary] Breakdown Params: ${JSON.stringify(breakdownParams)}`);
            const breakdownResult = await pool.query(breakdownQuery, breakdownParams);
            const breakdown = breakdownResult.rows[0];
            console.log(`[Dashboard Summary] ✅ Breakdown:`, JSON.stringify(breakdown));

            // DEBUG: Ver distribución COMPLETA de ventas (incluyendo todos los estados)
            let debugQuery = `
                SELECT
                    tipo_pago_id,
                    estado_venta_id,
                    COUNT(*) as count,
                    COALESCE(SUM(total), 0) as total
                FROM ventas
                WHERE tenant_id = $1 AND ${dateFilter}`;
            if (shouldFilterByBranch) {
                debugQuery += ` AND branch_id = $2`;
            }
            debugQuery += ` GROUP BY tipo_pago_id, estado_venta_id ORDER BY tipo_pago_id, estado_venta_id`;
            const debugResult = await pool.query(debugQuery, shouldFilterByBranch ? [tenantId, targetBranchId] : [tenantId]);
            console.log(`[Dashboard Summary] 🔍 DEBUG ventas por tipo_pago y estado:`, JSON.stringify(debugResult.rows));
            // tipo_pago_id: 1=Efectivo, 2=Tarjeta, 3=Crédito
            // estado_venta_id: 1=Borrador, 2=Asignada, 3=Completada, 5=Liquidada

            // Total de gastos (solo activos, excluir eliminados)
            let expensesQuery = `SELECT COALESCE(SUM(amount), 0) as total FROM expenses WHERE tenant_id = $1 AND is_active = true AND ${expenseDateFilter}`;
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

            // 🔍 DEBUG: Ver todos los gastos activos del tenant para entender por qué no coinciden
            const allExpensesDebug = await pool.query(`
                SELECT id, amount, expense_date,
                       expense_date AT TIME ZONE '${effectiveTimezone}' as expense_date_local,
                       (expense_date AT TIME ZONE '${effectiveTimezone}')::date as expense_date_only,
                       branch_id, id_turno, is_active
                FROM expenses
                WHERE tenant_id = $1 AND is_active = true
                ORDER BY expense_date DESC
                LIMIT 10
            `, [tenantId]);
            console.log(`[Dashboard Summary] 🔍 DEBUG - Todos los gastos activos del tenant:`);
            allExpensesDebug.rows.forEach(e => {
                console.log(`  - ID: ${e.id}, Amount: ${e.amount}, Date UTC: ${e.expense_date}, Local (${effectiveTimezone}): ${e.expense_date_local}, DateOnly: ${e.expense_date_only}, Branch: ${e.branch_id}, Shift: ${e.id_turno}`);
            });
            // Guardar para incluir en respuesta
            const expensesDebugInfo = allExpensesDebug.rows.map(e => ({
                id: e.id,
                amount: parseFloat(e.amount),
                dateUTC: e.expense_date,
                dateLocal: e.expense_date_local,
                dateOnly: e.expense_date_only,
                branch: e.branch_id,
                shift: e.id_turno
            }));

            // ═══════════════════════════════════════════════════════════════
            // TOTAL DE COMPRAS - Para el resumen financiero
            // ═══════════════════════════════════════════════════════════════
            let purchasesQuery = `
                SELECT
                    COALESCE(SUM(total_amount), 0) as total,
                    COUNT(*) as count
                FROM purchases
                WHERE tenant_id = $1
                AND payment_status != 'cancelled'`;
            let purchasesParams = [tenantId];
            let purchaseParamIndex = 2;

            if (shouldFilterByBranch) {
                purchasesQuery += ` AND branch_id = $${purchaseParamIndex}`;
                purchasesParams.push(targetBranchId);
                purchaseParamIndex++;
            }

            if (start_date && end_date) {
                // purchase_date es ahora 'timestamp with time zone' (timestamptz)
                purchasesQuery += ` AND (purchase_date AT TIME ZONE '${effectiveTimezone}')::date >= $${purchaseParamIndex}::date`;
                purchasesQuery += ` AND (purchase_date AT TIME ZONE '${effectiveTimezone}')::date <= $${purchaseParamIndex + 1}::date`;
                purchasesParams.push(start_date, end_date);
                purchaseParamIndex += 2;
            } else {
                // Sin fechas: usar el día actual en el timezone del cliente
                purchasesQuery += ` AND (purchase_date AT TIME ZONE '${effectiveTimezone}')::date = (NOW() AT TIME ZONE '${effectiveTimezone}')::date`;
            }

            const purchasesResult = await pool.query(purchasesQuery, purchasesParams);

            // Último corte de caja
            let cashCutQuery = `SELECT counted_cash FROM cash_cuts WHERE tenant_id = $1`;
            let cashCutParams = [tenantId];
            if (shouldFilterByBranch) {
                cashCutQuery += ` AND branch_id = $2`;
                cashCutParams.push(targetBranchId);
            }
            cashCutQuery += ` ORDER BY cut_date DESC LIMIT 1`;
            const cashCutResult = await pool.query(cashCutQuery, cashCutParams);

            // ═══════════════════════════════════════════════════════════════
            // KILOS NO REGISTRADOS - Guardian events de tipo 'peso_no_registrado'
            // ═══════════════════════════════════════════════════════════════
            let guardianKilosQuery = `
                SELECT COALESCE(SUM(weight_kg), 0) as total_kg
                FROM guardian_events
                WHERE tenant_id = $1
                AND event_type LIKE '%peso_no_registrado%'
                AND ${guardianDateFilter}`;
            let guardianKilosParams = [tenantId];
            let guardianParamIndex = 2;

            if (shouldFilterByBranch) {
                guardianKilosQuery += ` AND branch_id = $${guardianParamIndex}`;
                guardianKilosParams.push(targetBranchId);
                guardianParamIndex++;
            }

            if (shift_id) {
                guardianKilosQuery += ` AND shift_id = $${guardianParamIndex}`;
                guardianKilosParams.push(parseInt(shift_id));
                guardianParamIndex++;
            }

            console.log(`[Dashboard Summary] Guardian Kilos Query: ${guardianKilosQuery}`);
            console.log(`[Dashboard Summary] Guardian Kilos Params: ${JSON.stringify(guardianKilosParams)}`);
            const guardianKilosResult = await pool.query(guardianKilosQuery, guardianKilosParams);
            console.log(`[Dashboard Summary] ✅ Total kilos no registrados: ${guardianKilosResult.rows[0].total_kg}`);

            // ═══════════════════════════════════════════════════════════════
            // EVENTOS GUARDIAN NO LEÍDOS - Para badge de alertas
            // ═══════════════════════════════════════════════════════════════
            let guardianEventsQuery = `SELECT COUNT(*) as count FROM guardian_events WHERE tenant_id = $1 AND is_read = false`;
            let guardianEventsParams = [tenantId];
            let guardianEventsParamIndex = 2;

            if (shouldFilterByBranch) {
                guardianEventsQuery += ` AND branch_id = $${guardianEventsParamIndex}`;
                guardianEventsParams.push(targetBranchId);
                guardianEventsParamIndex++;
            }

            const guardianEventsResult = await pool.query(guardianEventsQuery, guardianEventsParams);
            console.log(`[Dashboard Summary] ✅ Unread Guardian events: ${guardianEventsResult.rows[0].count}`);

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

            // ═══════════════════════════════════════════════════════════════
            // TOTALES POR UNIDAD DE MEDIDA - kg, pz, L, etc.
            // ═══════════════════════════════════════════════════════════════
            let unitTotalsQuery = `
                SELECT COALESCE(um.abbreviation, 'kg') as unit, SUM(vd.cantidad) as total_qty
                FROM ventas v
                JOIN ventas_detalle vd ON vd.id_venta = v.id_venta
                LEFT JOIN productos p ON vd.id_producto = p.id AND p.tenant_id = v.tenant_id
                LEFT JOIN units_of_measure um ON p.unidad_medida_id = um.id
                WHERE v.tenant_id = $1 AND (
                    (v.estado_venta_id = 3 AND ${dateFilter.replace(/fecha_venta_utc/g, 'v.fecha_venta_utc')})
                    OR
                    (v.estado_venta_id = 5 AND ${dateFilter.replace(/fecha_venta_utc/g, 'COALESCE(v.fecha_liquidacion_utc, v.fecha_venta_utc)')})
                )`;
            let unitTotalsParams = [tenantId];
            let unitParamIndex = 2;

            if (shouldFilterByBranch) {
                unitTotalsQuery += ` AND v.branch_id = $${unitParamIndex}`;
                unitTotalsParams.push(targetBranchId);
                unitParamIndex++;
            }

            if (shift_id) {
                unitTotalsQuery += ` AND v.id_turno = $${unitParamIndex}`;
                unitTotalsParams.push(parseInt(shift_id));
                unitParamIndex++;
            }

            unitTotalsQuery += ` GROUP BY COALESCE(um.abbreviation, 'kg') ORDER BY total_qty DESC`;

            const unitTotalsResult = await pool.query(unitTotalsQuery, unitTotalsParams);
            const unitTotals = unitTotalsResult.rows.map(row => ({
                unit: row.unit,
                totalQty: parseFloat(row.total_qty)
            }));
            console.log(`[Dashboard Summary] ✅ Unit totals:`, JSON.stringify(unitTotals));

            // ═══════════════════════════════════════════════════════════════
            // TOP 3 CLIENTES - Clientes con más compras (excluyendo Público en General)
            // ═══════════════════════════════════════════════════════════════
            let topCustomerQuery = `
                SELECT c.nombre as customer_name, SUM(v.total) as total_amount, COUNT(*) as sale_count
                FROM ventas v
                JOIN customers c ON v.id_cliente = c.id
                WHERE v.tenant_id = $1
                AND c.is_system_generic = FALSE
                AND (
                    (v.estado_venta_id = 3 AND ${dateFilter.replace(/fecha_venta_utc/g, 'v.fecha_venta_utc')})
                    OR
                    (v.estado_venta_id = 5 AND ${dateFilter.replace(/fecha_venta_utc/g, 'COALESCE(v.fecha_liquidacion_utc, v.fecha_venta_utc)')})
                )`;
            let topCustomerParams = [tenantId];
            let topCustParamIndex = 2;

            if (shouldFilterByBranch) {
                topCustomerQuery += ` AND v.branch_id = $${topCustParamIndex}`;
                topCustomerParams.push(targetBranchId);
                topCustParamIndex++;
            }

            if (shift_id) {
                topCustomerQuery += ` AND v.id_turno = $${topCustParamIndex}`;
                topCustomerParams.push(parseInt(shift_id));
                topCustParamIndex++;
            }

            topCustomerQuery += ` GROUP BY c.id, c.nombre ORDER BY total_amount DESC LIMIT 3`;

            const topCustomerResult = await pool.query(topCustomerQuery, topCustomerParams);
            const topCustomers = topCustomerResult.rows.map(row => ({
                customerName: row.customer_name,
                totalAmount: parseFloat(row.total_amount),
                saleCount: parseInt(row.sale_count)
            }));
            // Keep backward compat: topCustomer = first item or null
            const topCustomer = topCustomers.length > 0 ? topCustomers[0] : null;
            console.log(`[Dashboard Summary] ✅ Top customers:`, JSON.stringify(topCustomers));

            // ═══════════════════════════════════════════════════════════════
            // TOP EMPLEADO - Empleado con más ventas
            // ═══════════════════════════════════════════════════════════════
            let topEmployeeQuery = `
                SELECT CONCAT(e.first_name, ' ', e.last_name) as employee_name,
                       SUM(v.total) as total_amount, COUNT(*) as sale_count
                FROM ventas v
                JOIN employees e ON v.id_empleado = e.id
                WHERE v.tenant_id = $1
                AND (
                    (v.estado_venta_id = 3 AND ${dateFilter.replace(/fecha_venta_utc/g, 'v.fecha_venta_utc')})
                    OR
                    (v.estado_venta_id = 5 AND ${dateFilter.replace(/fecha_venta_utc/g, 'COALESCE(v.fecha_liquidacion_utc, v.fecha_venta_utc)')})
                )`;
            let topEmployeeParams = [tenantId];
            let topEmpParamIndex = 2;

            if (shouldFilterByBranch) {
                topEmployeeQuery += ` AND v.branch_id = $${topEmpParamIndex}`;
                topEmployeeParams.push(targetBranchId);
                topEmpParamIndex++;
            }

            if (shift_id) {
                topEmployeeQuery += ` AND v.id_turno = $${topEmpParamIndex}`;
                topEmployeeParams.push(parseInt(shift_id));
                topEmpParamIndex++;
            }

            topEmployeeQuery += ` GROUP BY e.id, e.first_name, e.last_name ORDER BY total_amount DESC LIMIT 3`;

            const topEmployeeResult = await pool.query(topEmployeeQuery, topEmployeeParams);
            const topEmployees = topEmployeeResult.rows.map(row => ({
                employeeName: row.employee_name,
                totalAmount: parseFloat(row.total_amount),
                saleCount: parseInt(row.sale_count)
            }));
            // Backward compat
            const topEmployee = topEmployees.length > 0 ? topEmployees[0] : null;
            console.log(`[Dashboard Summary] ✅ Top employees:`, JSON.stringify(topEmployees));

            res.json({
                success: true,
                data: {
                    totalSales: parseFloat(salesResult.rows[0].total),
                    totalExpenses: parseFloat(expensesResult.rows[0].total),
                    totalPurchases: parseFloat(purchasesResult.rows[0].total),
                    purchasesCount: parseInt(purchasesResult.rows[0].count),
                    cashInDrawer: cashCutResult.rows.length > 0 ? parseFloat(cashCutResult.rows[0].counted_cash) : 0,
                    unreadGuardianEvents: parseInt(guardianEventsResult.rows[0].count),
                    totalKilosNoRegistrados: parseFloat(guardianKilosResult.rows[0].total_kg),
                    totalAssignments: parseInt(assignmentsResult.rows[0].total_assignments),
                    activeAssignments: parseInt(assignmentsResult.rows[0].active_assignments),
                    activeAssignmentsAmount: parseFloat(assignmentsResult.rows[0].active_amount),
                    // ✅ Desglose de ventas
                    salesBreakdown: {
                        // Por tipo de venta
                        mostradorTotal: parseFloat(breakdown.mostrador_total),
                        mostradorCount: parseInt(breakdown.mostrador_count),
                        repartidorLiquidado: parseFloat(breakdown.repartidor_liquidado),
                        repartidorCount: parseInt(breakdown.repartidor_count),
                        // Por método de pago
                        efectivoTotal: parseFloat(breakdown.efectivo_total),
                        tarjetaTotal: parseFloat(breakdown.tarjeta_total),
                        creditoTotal: parseFloat(breakdown.credito_total),
                        // Totales por unidad de medida
                        unitTotals: unitTotals,
                        // Top cliente (backward compat)
                        topCustomer: topCustomer,
                        // Top 3 clientes
                        topCustomers: topCustomers,
                        // Top empleado (backward compat)
                        topEmployee: topEmployee,
                        // Top 3 empleados
                        topEmployees: topEmployees
                    },
                    // 🔍 DEBUG: Gastos del tenant (TEMPORAL - remover después de debug)
                    _debug_expenses: expensesDebugInfo,
                    _debug_filter: expenseDateFilter,
                    _debug_timezone: effectiveTimezone
                }
            });
        } catch (error) {
            console.error('[Dashboard Summary] Error:', error);
            res.status(500).json({ success: false, message: 'Error al obtener resumen' });
        }
    });

    return router;
};
