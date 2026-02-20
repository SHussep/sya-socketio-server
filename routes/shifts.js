// ═══════════════════════════════════════════════════════════════
// SHIFTS ROUTES - Extracted from server.js
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET;
const { notifyShiftEnded } = require('../utils/notificationHelper');

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
    const router = express.Router();

    // POST /api/shifts/open - Abrir turno (inicio de sesión)
    router.post('/open', authenticateToken, async (req, res) => {
        try {
            const { tenantId, employeeId, branchId } = req.user;
            const { initialAmount } = req.body;

            // Verificar si hay un turno abierto para este empleado
            const existingShift = await pool.query(
                `SELECT id FROM shifts
                 WHERE tenant_id = $1 AND branch_id = $2 AND employee_id = $3 AND is_cash_cut_open = true`,
                [tenantId, branchId, employeeId]
            );

            if (existingShift.rows.length > 0) {
                return res.status(400).json({
                    success: false,
                    message: 'Ya tienes un turno abierto. Debes cerrar el turno actual antes de abrir uno nuevo.',
                    existingShiftId: existingShift.rows[0].id
                });
            }

            // Crear nuevo turno
            const result = await pool.query(
                `INSERT INTO shifts (tenant_id, branch_id, employee_id, start_time, initial_amount, transaction_counter, is_cash_cut_open)
                 VALUES ($1, $2, $3, CURRENT_TIMESTAMP, $4, 0, true)
                 RETURNING id, tenant_id, branch_id, employee_id, start_time, initial_amount, transaction_counter, is_cash_cut_open, created_at`,
                [tenantId, branchId, employeeId, initialAmount || 0]
            );

            const shift = result.rows[0];
            console.log(`[Shifts] 🚀 Turno abierto: ID ${shift.id} - Empleado ${employeeId} - Sucursal ${branchId}`);

            // Format timestamps as ISO strings in UTC
            const formattedShift = {
                ...shift,
                start_time: shift.start_time ? new Date(shift.start_time).toISOString() : null,
                created_at: shift.created_at ? new Date(shift.created_at).toISOString() : null
            };

            res.json({
                success: true,
                data: formattedShift,
                message: 'Turno abierto exitosamente'
            });

        } catch (error) {
            console.error('[Shifts] Error al abrir turno:', error);
            res.status(500).json({ success: false, message: 'Error al abrir turno' });
        }
    });

    // POST /api/shifts/close - Cerrar turno (cierre de sesión)
    router.post('/close', authenticateToken, async (req, res) => {
        try {
            const { tenantId, employeeId, branchId } = req.user;
            const { shiftId, finalAmount } = req.body;

            // Verificar que el turno existe, pertenece al empleado y está abierto
            const shiftCheck = await pool.query(
                `SELECT id, start_time FROM shifts
                 WHERE id = $1 AND tenant_id = $2 AND branch_id = $3 AND employee_id = $4 AND is_cash_cut_open = true`,
                [shiftId, tenantId, branchId, employeeId]
            );

            if (shiftCheck.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Turno no encontrado o ya está cerrado'
                });
            }

            // Cerrar el turno
            const result = await pool.query(
                `UPDATE shifts
                 SET end_time = CURRENT_TIMESTAMP,
                     final_amount = $1,
                     is_cash_cut_open = false,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = $2
                 RETURNING id, tenant_id, branch_id, employee_id, start_time, end_time, initial_amount, final_amount, transaction_counter, is_cash_cut_open`,
                [finalAmount || 0, shiftId]
            );

            const shift = result.rows[0];
            console.log(`[Shifts] 🔒 Turno cerrado: ID ${shift.id} - Empleado ${employeeId}`);

            // 🔌 EMIT Socket.IO para actualizar app móvil en tiempo real
            if (io) {
                const roomName = `branch_${branchId}`;
                console.log(`[Shifts] 📡 Emitiendo 'shift_ended' a ${roomName}`);
                io.to(roomName).emit('shift_ended', {
                    shiftId: shift.id,
                    employeeId: employeeId,
                    branchId: branchId,
                    endTime: shift.end_time ? new Date(shift.end_time).toISOString() : new Date().toISOString(),
                    finalAmount: parseFloat(shift.final_amount || 0),
                    source: 'post_close'
                });
            }

            // Format timestamps as ISO strings in UTC
            const formattedShift = {
                ...shift,
                start_time: shift.start_time ? new Date(shift.start_time).toISOString() : null,
                end_time: shift.end_time ? new Date(shift.end_time).toISOString() : null
            };

            res.json({
                success: true,
                data: formattedShift,
                message: 'Turno cerrado exitosamente'
            });

        } catch (error) {
            console.error('[Shifts] Error al cerrar turno:', error);
            res.status(500).json({ success: false, message: 'Error al cerrar turno' });
        }
    });

    // GET /api/shifts/current - Obtener turno actual del empleado
    router.get('/current', authenticateToken, async (req, res) => {
        try {
            const { tenantId, employeeId, branchId, roleId } = req.user;
            const isAdmin = roleId === 1; // roleId 1 = Administrador

            // 🎯 ADMINISTRADORES: Ven cualquier turno abierto de la sucursal
            // 🎯 EMPLEADOS: Solo ven su propio turno abierto
            let query = `
                SELECT s.id, s.global_id, s.tenant_id, s.branch_id, s.employee_id, s.start_time, s.end_time,
                       s.initial_amount, s.final_amount, s.transaction_counter, s.is_cash_cut_open,
                       COALESCE(NULLIF(CONCAT(COALESCE(e.first_name, ''), ' ', COALESCE(e.last_name, '')), ' '), e.username, 'Sin nombre') as employee_name,
                       COALESCE(r.name, 'Sin rol') as employee_role,
                       COALESCE(b.name, 'Sin sucursal') as branch_name
                FROM shifts s
                LEFT JOIN employees e ON s.employee_id = e.id
                LEFT JOIN roles r ON e.role_id = r.id
                LEFT JOIN branches b ON s.branch_id = b.id
                WHERE s.tenant_id = $1 AND s.is_cash_cut_open = true`;

            const params = [tenantId];

            // 🔒 CRÍTICO: SIEMPRE filtrar por employee_id para evitar confusión de turnos
            // Incluso si es admin, el turno ACTUAL debe ser del empleado logueado
            query += ' AND s.employee_id = $2';
            params.push(employeeId);

            // Si el JWT incluye branchId (Desktop), filtrar por sucursal
            if (branchId) {
                query += ` AND s.branch_id = $${params.length + 1}`;
                params.push(branchId);
            }

            query += ' ORDER BY s.start_time DESC LIMIT 1';

            console.log(`[Shifts Current] Fetching current shift - Tenant: ${tenantId}, Employee: ${employeeId}, Branch: ${branchId || 'all'}, isAdmin: ${isAdmin}`);
            console.log(`[Shifts Current] Query params: ${JSON.stringify(params)}`);

            const result = await pool.query(query, params);

            if (result.rows.length === 0) {
                return res.json({
                    success: true,
                    data: null,
                    message: 'No hay turno abierto'
                });
            }

            console.log(`[Shifts Current] ✅ Found shift ID ${result.rows[0].id} in branch ${result.rows[0].branch_name}`);

            // Format timestamps as ISO strings in UTC
            const formattedShift = result.rows[0] ? {
                ...result.rows[0],
                start_time: result.rows[0].start_time ? new Date(result.rows[0].start_time).toISOString() : null,
                end_time: result.rows[0].end_time ? new Date(result.rows[0].end_time).toISOString() : null
            } : null;

            res.json({
                success: true,
                data: formattedShift
            });

        } catch (error) {
            console.error('[Shifts] Error al obtener turno actual:', error);
            res.status(500).json({ success: false, message: 'Error al obtener turno actual' });
        }
    });

    // GET /api/shifts/history - Obtener historial de turnos (cortes de caja)
    // Parámetros:
    // - open_only=true: solo turnos abiertos (para selector de turnos)
    // - start_date: fecha inicio del filtro (ISO string)
    // - end_date: fecha fin del filtro (ISO string)
    router.get('/history', authenticateToken, async (req, res) => {
        try {
            const { tenantId, branchId: jwtBranchId } = req.user;
            const { limit = 50, offset = 0, all_branches = 'false', employee_id, open_only = 'false', start_date, end_date, branch_id } = req.query;

            // 🔧 IMPORTANTE: Permitir sobrescribir branchId via query parameter
            // Esto es necesario para que mobile app pueda ver datos de diferentes sucursales
            console.log(`[Shifts/History] 🔍 branch_id query param: ${branch_id}, jwtBranchId: ${jwtBranchId}`);
            const branchId = branch_id ? parseInt(branch_id) : jwtBranchId;
            console.log(`[Shifts/History] 🎯 branchId final usado: ${branchId}`);

            let query = `
                SELECT s.id, s.global_id, s.tenant_id, s.branch_id, s.employee_id, s.start_time, s.end_time,
                       s.initial_amount, s.final_amount, s.transaction_counter, s.is_cash_cut_open,
                       s.created_at, s.updated_at,
                       COALESCE(NULLIF(CONCAT(COALESCE(e.first_name, ''), ' ', COALESCE(e.last_name, '')), ' '), e.username, 'Sin nombre') as employee_name,
                       COALESCE(r.name, 'Sin rol') as employee_role,
                       COALESCE(b.name, 'Sin sucursal') as branch_name
                FROM shifts s
                LEFT JOIN employees e ON s.employee_id = e.id
                LEFT JOIN roles r ON e.role_id = r.id
                LEFT JOIN branches b ON s.branch_id = b.id
                WHERE s.tenant_id = $1
            `;

            const params = [tenantId];
            let paramIndex = 2;

            // ✅ NUEVO: Filtrar solo turnos abiertos si open_only=true
            if (open_only === 'true') {
                query += ` AND s.is_cash_cut_open = true`;
                console.log(`[Shifts/History] 🔍 Filtrando solo turnos abiertos`);
            }

            // Filtrar por sucursal si no se solicita todas
            if (all_branches !== 'true' && branchId) {
                query += ` AND s.branch_id = $${paramIndex}`;
                params.push(branchId);
                paramIndex++;
            }

            // Filtrar por empleado específico (para ver historial de un usuario)
            if (employee_id) {
                query += ` AND s.employee_id = $${paramIndex}`;
                params.push(employee_id);
                paramIndex++;
            }

            // 📅 NUEVO: Filtrar por rango de fechas
            if (start_date) {
                query += ` AND s.start_time >= $${paramIndex}`;
                params.push(start_date);
                paramIndex++;
                console.log(`[Shifts/History] 📅 Filtrando desde: ${start_date}`);
            }

            if (end_date) {
                query += ` AND s.start_time <= $${paramIndex}`;
                params.push(end_date);
                paramIndex++;
                console.log(`[Shifts/History] 📅 Filtrando hasta: ${end_date}`);
            }

            query += ` ORDER BY s.start_time DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
            params.push(limit, offset);

            // 🔍 DEBUG: Log query completa y parámetros
            console.log(`[Shifts/History] 🔍 QUERY COMPLETA:`);
            console.log(`[Shifts/History] 📝 SQL: ${query}`);
            console.log(`[Shifts/History] 📊 Params: ${JSON.stringify(params)}`);

            const result = await pool.query(query, params);
            console.log(`[Shifts/History] ✅ Turnos encontrados: ${result.rows.length}`);

            // Para cada turno, calcular totales de ventas, gastos, pagos, etc.
            const enrichedShifts = [];
            for (const shift of result.rows) {
                // 1. Calcular ventas DIRECTAS del empleado (sin asignaciones)
                // Solo incluir ventas donde id_turno_repartidor IS NULL
                // IMPORTANTE: Usar tipo_pago_id para pagos puros, y cash_amount/card_amount para mixtos
                // tipo_pago_id: 1=Efectivo, 2=Tarjeta, 3=Crédito, 4=Mixto
                const salesResult = await pool.query(`
                    SELECT
                        COALESCE(SUM(
                            CASE
                                WHEN tipo_pago_id = 4 THEN cash_amount
                                WHEN tipo_pago_id = 1 THEN total
                                ELSE 0
                            END
                        ), 0) as total_cash_sales,
                        COALESCE(SUM(
                            CASE
                                WHEN tipo_pago_id = 4 THEN card_amount
                                WHEN tipo_pago_id = 2 THEN total
                                ELSE 0
                            END
                        ), 0) as total_card_sales,
                        COALESCE(SUM(
                            CASE
                                WHEN tipo_pago_id = 4 THEN credit_amount
                                WHEN tipo_pago_id = 3 THEN total
                                ELSE 0
                            END
                        ), 0) as total_credit_sales
                    FROM ventas
                    WHERE id_turno = $1 AND id_turno_repartidor IS NULL
                `, [shift.id]);

                // 1B. Calcular ventas DE REPARTO que hizo este empleado (repartidor)
                // Estas son las ventas donde id_turno_repartidor = shift.id
                // IMPORTANTE: Usar tipo_pago_id para pagos puros, y cash_amount/card_amount para mixtos
                // tipo_pago_id: 1=Efectivo, 2=Tarjeta, 3=Crédito, 4=Mixto
                const assignmentSalesResult = await pool.query(`
                    SELECT
                        COALESCE(SUM(
                            CASE
                                WHEN tipo_pago_id = 4 THEN cash_amount
                                WHEN tipo_pago_id = 1 THEN total
                                ELSE 0
                            END
                        ), 0) as total_cash_assignments,
                        COALESCE(SUM(
                            CASE
                                WHEN tipo_pago_id = 4 THEN card_amount
                                WHEN tipo_pago_id = 2 THEN total
                                ELSE 0
                            END
                        ), 0) as total_card_assignments,
                        COALESCE(SUM(
                            CASE
                                WHEN tipo_pago_id = 4 THEN credit_amount
                                WHEN tipo_pago_id = 3 THEN total
                                ELSE 0
                            END
                        ), 0) as total_credit_assignments
                    FROM ventas
                    WHERE id_turno_repartidor = $1
                `, [shift.id]);

                // 1C. Obtener DESGLOSE DETALLADO de ventas de reparto (con cliente, cantidades, tipo pago)
                const assignmentSalesDetailResult = await pool.query(`
                    SELECT
                        v.id_venta,
                        v.ticket_number,
                        v.total,
                        v.tipo_pago_id,
                        v.fecha_venta_utc,
                        CASE
                            WHEN v.tipo_pago_id = 1 THEN 'Efectivo'
                            WHEN v.tipo_pago_id = 2 THEN 'Tarjeta'
                            WHEN v.tipo_pago_id = 3 THEN 'Crédito'
                            ELSE 'Otro'
                        END as payment_method_label,
                        c.nombre as customer_name,
                        (
                            SELECT COALESCE(SUM(cantidad), 0)
                            FROM ventas_detalle
                            WHERE id_venta = v.id_venta
                        ) as total_quantity
                    FROM ventas v
                    LEFT JOIN customers c ON v.id_cliente = c.id
                    WHERE v.id_turno_repartidor = $1
                    ORDER BY v.fecha_venta_utc DESC
                `, [shift.id]);

                // 2. Calcular gastos + desglose individual
                const expensesResult = await pool.query(`
                    SELECT
                        COALESCE(SUM(amount), 0) as total_expenses,
                        json_agg(
                            json_build_object(
                                'id', id,
                                'category', global_category_id,
                                'description', description,
                                'amount', amount,
                                'expense_date', expense_date
                            ) ORDER BY expense_date DESC
                        ) FILTER (WHERE id IS NOT NULL) as expenses_detail
                    FROM expenses
                    WHERE id_turno = $1 AND is_active = true
                `, [shift.id]);

                // 3. Calcular depósitos
                const depositsResult = await pool.query(`
                    SELECT COALESCE(SUM(amount), 0) as total_deposits
                    FROM deposits
                    WHERE shift_id = $1
                `, [shift.id]);

                // 4. Calcular retiros
                const withdrawalsResult = await pool.query(`
                    SELECT COALESCE(SUM(amount), 0) as total_withdrawals
                    FROM withdrawals
                    WHERE shift_id = $1
                `, [shift.id]);

                // 5. Calcular pagos de clientes
                const paymentsResult = await pool.query(`
                    SELECT
                        COALESCE(SUM(CASE WHEN payment_method = 'cash' THEN amount ELSE 0 END), 0) as total_cash_payments,
                        COALESCE(SUM(CASE WHEN payment_method = 'card' THEN amount ELSE 0 END), 0) as total_card_payments
                    FROM credit_payments
                    WHERE shift_id = $1
                `, [shift.id]);

                // 6. 🆕 Contar asignaciones de repartidor (DOS tipos diferentes)
                // IMPORTANTE: Usar shift_global_id para compatibilidad Desktop-PostgreSQL

                // 6A. Asignaciones CREADAS por este turno (vendedor/mostrador asignó mercancía)
                // Solo contar asignaciones NO liquidadas (fecha_liquidacion IS NULL)
                // FIX: Usar shift_id (INTEGER) en lugar de shift_global_id (no existe en la tabla)
                const createdAssignmentsResult = await pool.query(`
                    SELECT COUNT(*) as created_assignments
                    FROM repartidor_assignments ra
                    WHERE ra.shift_id = $1
                      AND ra.fecha_liquidacion IS NULL
                `, [shift.id]);

                // 6B. Asignaciones RECIBIDAS por este turno (repartidor tiene mercancía asignada)
                // Usar repartidor_shift_id (columna real del schema en Render)
                // Solo contar asignaciones NO liquidadas (fecha_liquidacion IS NULL)
                const receivedAssignmentsResult = await pool.query(`
                    SELECT COUNT(*) as received_assignments
                    FROM repartidor_assignments ra
                    WHERE ra.repartidor_shift_id = $1
                      AND ra.fecha_liquidacion IS NULL
                `, [shift.id]);

                // 7. Obtener liquidaciones consolidadas
                // Para turnos ABIERTOS: calcular desde ventas de repartidores liquidadas (mismo enfoque que Desktop)
                // Para turnos CERRADOS: usar datos almacenados en cash_cuts (ya sincronizados desde Desktop)
                // IMPORTANTE: Solo incluir si cajero_consolida_liquidaciones = true en la sucursal
                let totalLiquidacionesEfectivo = 0;
                let totalLiquidacionesTarjeta = 0;
                let totalLiquidacionesCredito = 0;
                let totalRepartidorExpenses = 0;

                const isRepartidor = shift.employee_role?.toLowerCase() === 'repartidor';

                // Verificar si la sucursal tiene modo consolidación activo
                let cajeroConsolida = false;
                try {
                    const branchSettingResult = await pool.query(
                        'SELECT cajero_consolida_liquidaciones FROM branches WHERE id = $1',
                        [shift.branch_id]
                    );
                    cajeroConsolida = branchSettingResult.rows[0]?.cajero_consolida_liquidaciones === true;
                } catch (settingErr) {
                    console.warn(`[Shifts/History] ⚠️ Error leyendo setting de branch: ${settingErr.message}`);
                }

                if (shift.is_cash_cut_open && !isRepartidor && cajeroConsolida) {
                    // Turno ABIERTO de cajero: calcular desde ventas de repartidores liquidadas
                    try {
                        const liquidacionesResult = await pool.query(`
                            SELECT
                                COALESCE(SUM(CASE
                                    WHEN v.tipo_pago_id = 4 THEN COALESCE(v.cash_amount, 0)
                                    WHEN v.tipo_pago_id = 1 THEN v.total
                                    ELSE 0
                                END), 0) as total_liquidaciones_efectivo,
                                COALESCE(SUM(CASE
                                    WHEN v.tipo_pago_id = 4 THEN COALESCE(v.card_amount, 0)
                                    WHEN v.tipo_pago_id = 2 THEN v.total
                                    ELSE 0
                                END), 0) as total_liquidaciones_tarjeta,
                                COALESCE(SUM(CASE
                                    WHEN v.tipo_pago_id = 4 THEN COALESCE(v.credit_amount, 0)
                                    WHEN v.tipo_pago_id = 3 THEN v.total
                                    ELSE 0
                                END), 0) as total_liquidaciones_credito
                            FROM ventas v
                            WHERE v.id_venta IN (
                                SELECT DISTINCT ra.venta_id
                                FROM repartidor_assignments ra
                                WHERE ra.status = 'liquidated'
                                  AND ra.fecha_liquidacion >= $1
                                  AND ra.venta_id IS NOT NULL
                            )
                              AND v.branch_id = $2
                              AND v.tenant_id = $3
                        `, [shift.start_time, shift.branch_id, shift.tenant_id]);

                        totalLiquidacionesEfectivo = parseFloat(liquidacionesResult.rows[0]?.total_liquidaciones_efectivo || 0);
                        totalLiquidacionesTarjeta = parseFloat(liquidacionesResult.rows[0]?.total_liquidaciones_tarjeta || 0);
                        totalLiquidacionesCredito = parseFloat(liquidacionesResult.rows[0]?.total_liquidaciones_credito || 0);
                    } catch (liqErr) {
                        console.warn(`[Shifts/History] ⚠️ Error calculando liquidaciones para turno ${shift.id}: ${liqErr.message}`);
                    }

                    // Gastos de repartidores: leer de tabla expenses de turnos repartidores
                    // (repartidor_liquidations.total_gastos solo existe tras liquidación formal)
                    try {
                        const repartidorExpensesResult = await pool.query(`
                            SELECT COALESCE(SUM(e.amount), 0) as total_repartidor_expenses
                            FROM expenses e
                            INNER JOIN shifts s ON e.id_turno = s.id
                            INNER JOIN employees emp ON s.employee_id = emp.id
                            INNER JOIN roles r ON emp.role_id = r.id
                            WHERE LOWER(r.name) = 'repartidor'
                              AND s.branch_id = $1
                              AND s.tenant_id = $2
                              AND s.start_time >= $3
                        `, [shift.branch_id, shift.tenant_id, shift.start_time]);

                        totalRepartidorExpenses = parseFloat(repartidorExpensesResult.rows[0]?.total_repartidor_expenses || 0);
                    } catch (repErr) {
                        console.warn(`[Shifts/History] ⚠️ Error leyendo gastos repartidores: ${repErr.message}`);
                    }
                } else {
                    // Turno CERRADO o repartidor: usar datos del cash_cut sincronizado
                    try {
                        const liquidacionesResult = await pool.query(`
                            SELECT
                                COALESCE(total_liquidaciones_efectivo, 0) as total_liquidaciones_efectivo,
                                COALESCE(total_liquidaciones_tarjeta, 0) as total_liquidaciones_tarjeta,
                                COALESCE(total_liquidaciones_credito, 0) as total_liquidaciones_credito,
                                COALESCE(total_repartidor_expenses, 0) as total_repartidor_expenses
                            FROM cash_cuts
                            WHERE shift_id = $1 AND is_closed = true
                            ORDER BY id DESC LIMIT 1
                        `, [shift.id]);

                        if (liquidacionesResult.rows.length > 0) {
                            totalLiquidacionesEfectivo = parseFloat(liquidacionesResult.rows[0].total_liquidaciones_efectivo || 0);
                            totalLiquidacionesTarjeta = parseFloat(liquidacionesResult.rows[0].total_liquidaciones_tarjeta || 0);
                            totalLiquidacionesCredito = parseFloat(liquidacionesResult.rows[0].total_liquidaciones_credito || 0);
                            totalRepartidorExpenses = parseFloat(liquidacionesResult.rows[0].total_repartidor_expenses || 0);
                        }
                    } catch (cashCutErr) {
                        console.warn(`[Shifts/History] ⚠️ Error leyendo cash_cuts para turno ${shift.id}: ${cashCutErr.message}`);
                    }
                }

                enrichedShifts.push({
                    ...shift,
                    start_time: shift.start_time ? new Date(shift.start_time).toISOString() : null,
                    end_time: shift.end_time ? new Date(shift.end_time).toISOString() : null,
                    created_at: shift.created_at ? new Date(shift.created_at).toISOString() : null,
                    updated_at: shift.updated_at ? new Date(shift.updated_at).toISOString() : null,
                    total_cash_sales: parseFloat(salesResult.rows[0]?.total_cash_sales || 0),
                    total_card_sales: parseFloat(salesResult.rows[0]?.total_card_sales || 0),
                    total_credit_sales: parseFloat(salesResult.rows[0]?.total_credit_sales || 0),
                    // 🆕 Ventas de reparto que hizo el repartidor (id_turno_repartidor = shift.id)
                    total_cash_assignments: parseFloat(assignmentSalesResult.rows[0]?.total_cash_assignments || 0),
                    total_card_assignments: parseFloat(assignmentSalesResult.rows[0]?.total_card_assignments || 0),
                    total_credit_assignments: parseFloat(assignmentSalesResult.rows[0]?.total_credit_assignments || 0),
                    // 🆕 Desglose detallado de ventas de reparto (cliente, cantidades, tipo pago)
                    assignment_sales_detail: assignmentSalesDetailResult.rows.map(sale => ({
                        id: sale.id_venta,
                        ticket_number: sale.ticket_number,
                        total: parseFloat(sale.total),
                        payment_method_id: sale.tipo_pago_id,
                        payment_method_label: sale.payment_method_label,
                        sale_date: sale.fecha_venta_utc ? new Date(sale.fecha_venta_utc).toISOString() : null,
                        customer_name: sale.customer_name || null,
                        total_quantity: parseFloat(sale.total_quantity || 0),
                    })),
                    total_expenses: parseFloat(expensesResult.rows[0]?.total_expenses || 0),
                    expenses_detail: expensesResult.rows[0]?.expenses_detail || [],  // 🆕 Desglose de gastos
                    total_deposits: parseFloat(depositsResult.rows[0]?.total_deposits || 0),
                    total_withdrawals: parseFloat(withdrawalsResult.rows[0]?.total_withdrawals || 0),
                    total_cash_payments: parseFloat(paymentsResult.rows[0]?.total_cash_payments || 0),
                    total_card_payments: parseFloat(paymentsResult.rows[0]?.total_card_payments || 0),
                    // 🚚 Asignaciones de repartidor (DOS contadores diferentes)
                    created_assignments: parseInt(createdAssignmentsResult.rows[0]?.created_assignments || 0),
                    received_assignments: parseInt(receivedAssignmentsResult.rows[0]?.received_assignments || 0),
                    // 💰 Liquidaciones consolidadas (calculadas desde ventas para turnos abiertos, desde cash_cuts para cerrados)
                    total_liquidaciones_efectivo: totalLiquidacionesEfectivo,
                    total_liquidaciones_tarjeta: totalLiquidacionesTarjeta,
                    total_liquidaciones_credito: totalLiquidacionesCredito,
                    // 💸 Gastos de repartidores (separados de gastos del cajero)
                    total_repartidor_expenses: totalRepartidorExpenses,
                    // ⚙️ Setting de consolidación para que mobile sepa el modo activo
                    cajero_consolida_liquidaciones: cajeroConsolida,
                });
            }

            res.json({
                success: true,
                data: enrichedShifts
            });

        } catch (error) {
            console.error('[Shifts] Error al obtener historial:', error);
            res.status(500).json({ success: false, message: 'Error al obtener historial de turnos', error: error.message });
        }
    });

    // GET /api/shifts/summary - Resumen de cortes de caja CERRADOS (para administradores)
    // Solo incluye turnos cerrados (is_cash_cut_open = false) para el resumen de cortes
    router.get('/summary', authenticateToken, async (req, res) => {
        try {
            const { tenantId } = req.user;
            const { date_from, date_to, branch_id } = req.query;

            let query = `
                SELECT s.id, s.branch_id, s.employee_id, s.start_time, s.end_time,
                       s.initial_amount, s.final_amount, s.transaction_counter, s.is_cash_cut_open,
                       COALESCE(NULLIF(CONCAT(COALESCE(e.first_name, ''), ' ', COALESCE(e.last_name, '')), ' '), e.username, 'Sin nombre') as employee_name,
                       COALESCE(b.name, 'Sin sucursal') as branch_name,
                       (s.final_amount - s.initial_amount) as difference
                FROM shifts s
                LEFT JOIN employees e ON s.employee_id = e.id
                LEFT JOIN branches b ON s.branch_id = b.id
                WHERE s.tenant_id = $1
                  AND s.is_cash_cut_open = false
            `;

            const params = [tenantId];
            let paramIndex = 2;

            if (branch_id) {
                query += ` AND s.branch_id = $${paramIndex}`;
                params.push(branch_id);
                paramIndex++;
            }

            // Filtrar por rango de fechas (solo aplica a turnos cerrados)
            if (date_from) {
                query += ` AND s.start_time >= $${paramIndex}`;
                params.push(date_from);
                paramIndex++;
            }

            if (date_to) {
                query += ` AND s.start_time <= $${paramIndex}`;
                params.push(date_to);
                paramIndex++;
            }

            query += ` ORDER BY s.start_time DESC`;

            const result = await pool.query(query, params);

            // Format timestamps as ISO strings in UTC
            const formattedRows = result.rows.map(row => ({
                ...row,
                start_time: row.start_time ? new Date(row.start_time).toISOString() : null,
                end_time: row.end_time ? new Date(row.end_time).toISOString() : null
            }));

            // Calcular totales (solo de turnos cerrados)
            const summary = {
                total_shifts: formattedRows.length,
                total_transactions: formattedRows.reduce((sum, shift) => sum + (shift.transaction_counter || 0), 0),
                total_initial: formattedRows.reduce((sum, shift) => sum + parseFloat(shift.initial_amount || 0), 0),
                total_final: formattedRows.reduce((sum, shift) => sum + parseFloat(shift.final_amount || 0), 0),
                shifts: formattedRows
            };

            summary.total_difference = summary.total_final - summary.total_initial;

            res.json({
                success: true,
                data: summary
            });

        } catch (error) {
            console.error('[Shifts] Error al obtener resumen:', error);
            res.status(500).json({ success: false, message: 'Error al obtener resumen de cortes' });
        }
    });

    // PUT /api/shifts/:id/increment-counter - Incrementar contador de transacciones
    router.put('/:id/increment-counter', authenticateToken, async (req, res) => {
        try {
            const { tenantId } = req.user;
            const { id } = req.params;

            const result = await pool.query(
                `UPDATE shifts
                 SET transaction_counter = transaction_counter + 1,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = $1 AND tenant_id = $2 AND is_cash_cut_open = true
                 RETURNING transaction_counter`,
                [id, tenantId]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({ success: false, message: 'Turno no encontrado o cerrado' });
            }

            res.json({
                success: true,
                data: { transaction_counter: result.rows[0].transaction_counter }
            });

        } catch (error) {
            console.error('[Shifts] Error al incrementar contador:', error);
            res.status(500).json({ success: false, message: 'Error al incrementar contador' });
        }
    });

    // GET /api/shifts/check-active - Verificar si el empleado tiene un turno activo en PostgreSQL
    // Usado por Desktop para validar antes de abrir turno local
    router.get('/check-active', async (req, res) => {
        try {
            const { tenant_id, branch_id, employee_id, employee_global_id } = req.query;

            console.log(`[Shifts/CheckActive] 🔍 Verificando turno activo - Tenant: ${tenant_id}, Branch: ${branch_id}, Employee: ${employee_id || employee_global_id}`);

            if (!tenant_id || !branch_id) {
                return res.status(400).json({
                    success: false,
                    message: 'tenant_id y branch_id son requeridos'
                });
            }

            // Resolver employee_id si se envió global_id
            let resolvedEmployeeId = employee_id;
            if (employee_global_id && !employee_id) {
                const empResult = await pool.query(
                    'SELECT id FROM employees WHERE global_id = $1 AND tenant_id = $2',
                    [employee_global_id, tenant_id]
                );
                if (empResult.rows.length > 0) {
                    resolvedEmployeeId = empResult.rows[0].id;
                } else {
                    return res.json({
                        success: true,
                        hasActiveShift: false,
                        message: 'Empleado no encontrado'
                    });
                }
            }

            if (!resolvedEmployeeId) {
                return res.status(400).json({
                    success: false,
                    message: 'employee_id o employee_global_id requerido'
                });
            }

            // Buscar turno activo para este empleado en CUALQUIER sucursal
            // Un empleado no puede tener turnos abiertos en múltiples sucursales
            const existingShift = await pool.query(
                `SELECT s.id, s.global_id, s.start_time, s.initial_amount, s.terminal_id,
                        s.branch_id as shift_branch_id,
                        b.name as branch_name,
                        CONCAT(e.first_name, ' ', e.last_name) as employee_name
                 FROM shifts s
                 LEFT JOIN employees e ON s.employee_id = e.id
                 LEFT JOIN branches b ON s.branch_id = b.id
                 WHERE s.tenant_id = $1
                   AND s.employee_id = $2
                   AND s.is_cash_cut_open = true
                 ORDER BY s.start_time DESC
                 LIMIT 1`,
                [tenant_id, resolvedEmployeeId]
            );

            if (existingShift.rows.length > 0) {
                const shift = existingShift.rows[0];
                const isOtherBranch = shift.shift_branch_id !== parseInt(branch_id);

                console.log(`[Shifts/CheckActive] ⚠️ Turno activo encontrado: ID ${shift.id} (GlobalId: ${shift.global_id}) - Sucursal: ${shift.branch_name} ${isOtherBranch ? '(OTRA SUCURSAL)' : ''}`);

                return res.json({
                    success: true,
                    hasActiveShift: true,
                    shift: {
                        id: shift.id,
                        global_id: shift.global_id,
                        start_time: shift.start_time,
                        initial_amount: parseFloat(shift.initial_amount),
                        terminal_id: shift.terminal_id,
                        employee_name: shift.employee_name,
                        branch_id: shift.shift_branch_id,
                        branch_name: shift.branch_name,
                        is_other_branch: isOtherBranch
                    },
                    message: isOtherBranch
                        ? `El empleado tiene un turno abierto en ${shift.branch_name}`
                        : 'El empleado ya tiene un turno abierto'
                });
            }

            console.log(`[Shifts/CheckActive] ✅ No hay turno activo para empleado ${resolvedEmployeeId}`);
            return res.json({
                success: true,
                hasActiveShift: false,
                message: 'No hay turno activo'
            });

        } catch (error) {
            console.error('[Shifts/CheckActive] ❌ Error:', error.message);
            res.status(500).json({
                success: false,
                message: 'Error al verificar turno activo',
                error: undefined
            });
        }
    });

    // POST /api/sync/shifts/open - Abrir turno desde Desktop (sin JWT)
    // Implementa smart UPSERT con auto-close para offline-first sync
    router.post('/sync/open', async (req, res) => {
        try {
            const { tenantId, branchId, employeeId, initialAmount, userEmail, localShiftId } = req.body;

            console.log(`[Sync/Shifts] Desktop sync - Tenant: ${tenantId}, Branch: ${branchId}, Employee: ${employeeId}, LocalShiftId: ${localShiftId}`);

            if (!tenantId || !branchId || !employeeId) {
                return res.status(400).json({
                    success: false,
                    message: 'Datos incompletos (tenantId, branchId, employeeId requeridos)'
                });
            }

            // ⚠️ VALIDACIÓN: Verificar que no haya un turno activo para este empleado
            const activeShiftCheck = await pool.query(
                `SELECT id, global_id, terminal_id, start_time FROM shifts
                 WHERE tenant_id = $1 AND branch_id = $2 AND employee_id = $3 AND is_cash_cut_open = true
                 AND local_shift_id != $4`,
                [tenantId, branchId, employeeId, localShiftId || 0]
            );

            if (activeShiftCheck.rows.length > 0) {
                const existing = activeShiftCheck.rows[0];
                console.log(`[Sync/Shifts] ⚠️ Turno activo encontrado en otro dispositivo: ID ${existing.id} (Terminal: ${existing.terminal_id})`);

                return res.status(409).json({
                    success: false,
                    message: 'El empleado ya tiene un turno abierto en otro dispositivo. Ciérrelo primero.',
                    existingShift: {
                        id: existing.id,
                        global_id: existing.global_id,
                        terminal_id: existing.terminal_id,
                        start_time: existing.start_time
                    }
                });
            }

            // Buscar nombre del empleado para la notificación
            let employeeName = 'Empleado';
            try {
                const empResult = await pool.query(
                    'SELECT first_name, last_name, username FROM employees WHERE id = $1',
                    [employeeId]
                );
                if (empResult.rows.length > 0) {
                    const emp = empResult.rows[0];
                    employeeName = emp.first_name ? `${emp.first_name} ${emp.last_name || ''}`.trim() : emp.username;
                }
            } catch (e) {
                console.warn('[Sync/Shifts] No se pudo obtener nombre del empleado:', e.message);
            }

            // Buscar nombre de la sucursal para la notificación
            let branchName = 'Sucursal';
            try {
                const branchResult = await pool.query(
                    'SELECT name FROM branches WHERE id = $1',
                    [branchId]
                );
                if (branchResult.rows.length > 0) {
                    branchName = branchResult.rows[0].name;
                }
            } catch (e) {
                console.warn('[Sync/Shifts] No se pudo obtener nombre de la sucursal:', e.message);
            }

            // PASO 1: Verificar si hay un turno abierto con DIFERENTE local_shift_id
            // Si existe, significa que fue cerrado offline y necesita auto-cerrarse en PostgreSQL
            const existingShift = await pool.query(
                `SELECT id, local_shift_id, start_time FROM shifts
                 WHERE employee_id = $1 AND end_time IS NULL AND local_shift_id IS NOT NULL AND local_shift_id != $2`,
                [employeeId, localShiftId]
            );

            if (existingShift.rows.length > 0) {
                const oldShift = existingShift.rows[0];
                console.log(`[Sync/Shifts] 🔄 Detectado cierre offline - Auto-cerrando shift ${oldShift.id} (localShiftId: ${oldShift.local_shift_id})`);

                // Auto-cerrar el turno anterior (fue cerrado en Desktop offline)
                const autoCloseResult = await pool.query(
                    `UPDATE shifts SET end_time = CURRENT_TIMESTAMP, is_cash_cut_open = false, updated_at = NOW()
                     WHERE id = $1
                     RETURNING id, global_id, employee_id, branch_id, start_time, end_time`,
                    [oldShift.id]
                );

                console.log(`[Sync/Shifts] ✅ Shift ${oldShift.id} auto-cerrado por sincronización offline`);

                // 📢 NOTIFICAR VIA SOCKET.IO: Turno auto-cerrado
                if (io && autoCloseResult.rows.length > 0) {
                    const closedShift = autoCloseResult.rows[0];
                    const roomName = `branch_${branchId}`;
                    console.log(`[Sync/Shifts] 📡 Emitiendo 'shift_auto_closed' a ${roomName}`);
                    io.to(roomName).emit('shift_auto_closed', {
                        shiftId: closedShift.id,
                        globalId: closedShift.global_id,
                        employeeId: closedShift.employee_id,
                        employeeName: employeeName,
                        branchId: branchId,
                        branchName: branchName,
                        startTime: closedShift.start_time,
                        endTime: closedShift.end_time,
                        reason: 'new_shift_opened_offline',
                        newShiftLocalId: localShiftId,
                        closedBy: 'system',
                        message: `Turno de ${employeeName} cerrado automáticamente porque se abrió un nuevo turno desde otro dispositivo`
                    });
                }
            }

            // PASO 2: Crear nuevo turno con el local_shift_id
            const result = await pool.query(
                `INSERT INTO shifts (tenant_id, branch_id, employee_id, local_shift_id, start_time, initial_amount, transaction_counter, is_cash_cut_open)
                 VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, $5, 0, true)
                 RETURNING id, tenant_id, branch_id, employee_id, local_shift_id, start_time, initial_amount, transaction_counter, is_cash_cut_open, created_at`,
                [tenantId, branchId, employeeId, localShiftId, initialAmount || 0]
            );

            const shift = result.rows[0];
            console.log(`[Sync/Shifts] ✅ Turno sincronizado desde Desktop: ID ${shift.id} (localShiftId: ${shift.local_shift_id}) - Employee ${employeeId} - Branch ${branchId} - Initial $${initialAmount}`);

            // 📢 EMITIR EVENTO SOCKET.IO
            if (io) {
                const roomName = `branch_${branchId}`;
                console.log(`[Sync/Shifts] 📡 Emitiendo 'shift_started' a ${roomName} para empleado ${employeeId}`);
                io.to(roomName).emit('shift_started', {
                    shiftId: shift.id,
                    employeeId: employeeId,
                    employeeName: employeeName,
                    branchId: branchId,
                    branchName: branchName,
                    initialAmount: parseFloat(initialAmount || 0),
                    startTime: new Date().toISOString(),
                    source: 'desktop_sync'
                });
            }

            res.json({
                success: true,
                data: shift,
                message: 'Turno abierto exitosamente'
            });

        } catch (error) {
            console.error('[Sync/Shifts] Error al abrir turno:', error);
            res.status(500).json({
                success: false,
                message: 'Error al abrir turno',
                error: undefined
            });
        }
    });

    // POST /api/shifts/sync - Sincronizar turno desde Desktop (offline-first idempotente)
    router.post('/sync', async (req, res) => {
        try {
            const {
                tenant_id,
                branch_id,
                employee_id,  // Deprecated - mantener por compatibilidad
                employee_global_id,  // ✅ NUEVO: UUID del empleado (idempotente)
                start_time,
                end_time,  // Agregar end_time
                initial_amount,
                final_amount,  // Agregar final_amount
                transaction_counter,
                is_cash_cut_open,
                // Offline-first fields
                global_id,
                terminal_id,
                local_op_seq,
                created_local_utc,
                device_event_raw,
                local_shift_id  // ID del turno en Desktop
            } = req.body;

            // Validación
            if (!tenant_id || !branch_id || !global_id) {
                return res.status(400).json({
                    success: false,
                    message: 'Datos incompletos (tenant_id, branch_id, global_id requeridos)'
                });
            }

            // ✅ RESOLVER employee_id usando global_id (offline-first)
            let resolvedEmployeeId = employee_id;
            if (employee_global_id) {
                console.log(`[Sync/Shifts] 🔍 Resolviendo empleado con global_id: ${employee_global_id}`);
                const employeeLookup = await pool.query(
                    'SELECT id FROM employees WHERE global_id = $1 AND tenant_id = $2',
                    [employee_global_id, tenant_id]
                );

                if (employeeLookup.rows.length > 0) {
                    resolvedEmployeeId = employeeLookup.rows[0].id;
                    console.log(`[Sync/Shifts] ✅ Empleado resuelto: global_id ${employee_global_id} → id ${resolvedEmployeeId}`);
                } else {
                    console.log(`[Sync/Shifts] ❌ Empleado no encontrado con global_id: ${employee_global_id}`);
                    return res.status(400).json({
                        success: false,
                        message: `Empleado no encontrado con global_id: ${employee_global_id}`
                    });
                }
            }

            if (!resolvedEmployeeId) {
                return res.status(400).json({
                    success: false,
                    message: 'employee_id o employee_global_id requerido'
                });
            }

            // ✅ IDEMPOTENTE: INSERT con ON CONFLICT (global_id) DO UPDATE
            const result = await pool.query(
                `INSERT INTO shifts (
                    tenant_id, branch_id, employee_id, start_time, end_time,
                    initial_amount, final_amount, transaction_counter, is_cash_cut_open,
                    global_id, terminal_id, local_op_seq, created_local_utc, device_event_raw
                 )
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
                 ON CONFLICT (global_id) DO UPDATE
                 SET end_time = EXCLUDED.end_time,
                     final_amount = EXCLUDED.final_amount,
                     transaction_counter = EXCLUDED.transaction_counter,
                     is_cash_cut_open = EXCLUDED.is_cash_cut_open,
                     updated_at = NOW()
                 RETURNING *`,
                [
                    tenant_id,
                    branch_id,
                    resolvedEmployeeId,  // ✅ Usar ID resuelto
                    start_time,
                    end_time || null,
                    initial_amount || 0,
                    final_amount || null,
                    transaction_counter || 0,
                    is_cash_cut_open,
                    global_id,
                    terminal_id || null,
                    local_op_seq || null,
                    created_local_utc || null,
                    device_event_raw || null
                ]
            );

            const shift = result.rows[0];

            console.log(`[Sync/Shifts] ✅ Turno sincronizado: ID ${shift.id} (LocalShiftId: ${local_shift_id}) - Employee ${resolvedEmployeeId}`);

            // 🔌 EMIT Socket.IO para actualizar app móvil en tiempo real
            if (io) {
                const roomName = `branch_${branch_id}`;
                if (is_cash_cut_open === false && end_time) {
                    // Turno cerrado
                    console.log(`[Sync/Shifts] 📡 Emitiendo 'shift_ended' a ${roomName} (sync general)`);
                    io.to(roomName).emit('shift_ended', {
                        shiftId: shift.id,
                        globalId: shift.global_id,
                        employeeId: resolvedEmployeeId,
                        branchId: branch_id,
                        endTime: end_time,
                        finalAmount: parseFloat(final_amount || 0),
                        source: 'rest_sync'
                    });
                } else if (is_cash_cut_open !== false) {
                    // Turno abierto
                    console.log(`[Sync/Shifts] 📡 Emitiendo 'shift_started' a ${roomName} (sync general)`);
                    io.to(roomName).emit('shift_started', {
                        shiftId: shift.id,
                        employeeId: resolvedEmployeeId,
                        branchId: branch_id,
                        initialAmount: parseFloat(initial_amount || 0),
                        startTime: start_time || new Date().toISOString(),
                        source: 'rest_sync'
                    });
                }
            }

            // 🔔 ENVIAR NOTIFICACIONES FCM SI ES CIERRE DE TURNO
            if (is_cash_cut_open === false && end_time) {
                console.log(`[Sync/Shifts] 📨 Detectado cierre de turno - Enviando notificaciones FCM`);

                try {
                    // Obtener datos del empleado para las notificaciones
                    const employeeData = await pool.query(
                        `SELECT CONCAT(first_name, ' ', last_name) as full_name, global_id
                         FROM employees WHERE id = $1`,
                        [resolvedEmployeeId]
                    );

                    // Obtener nombre de la sucursal desde el branch_id del shift
                    const branchData = await pool.query(
                        `SELECT name FROM branches WHERE id = $1`,
                        [branch_id]
                    );

                    if (employeeData.rows.length > 0 && branchData.rows.length > 0) {
                        const employee = employeeData.rows[0];
                        const branch = branchData.rows[0];

                        // ✅ CORREGIDO: Buscar el cash cut del turno para obtener los valores reales
                        // El cash cut ya tiene expected_cash_in_drawer calculado correctamente
                        // (incluye fondo + ventas - gastos)
                        const cashCutData = await pool.query(
                            `SELECT expected_cash_in_drawer, counted_cash, difference
                             FROM cash_cuts
                             WHERE shift_id = $1 AND tenant_id = $2
                             ORDER BY created_at DESC LIMIT 1`,
                            [shift.id, tenant_id]
                        );

                        let countedCash, expectedCash, difference;

                        if (cashCutData.rows.length > 0) {
                            // Usar valores del cash cut (correctos)
                            const cashCut = cashCutData.rows[0];
                            countedCash = parseFloat(cashCut.counted_cash) || 0;
                            expectedCash = parseFloat(cashCut.expected_cash_in_drawer) || 0;
                            difference = parseFloat(cashCut.difference) || 0;
                            console.log(`[Sync/Shifts] 📊 Usando valores de cash_cut: Expected=$${expectedCash}, Counted=$${countedCash}, Diff=$${difference}`);
                        } else {
                            // ⏭️ No hay cash_cut aún - la notificación se enviará desde cash-cuts.js
                            // cuando se sincronice el corte de caja (donde tenemos los valores correctos)
                            console.log(`[Sync/Shifts] ⏭️ No se encontró cash_cut aún, notificación se enviará desde cash-cuts sync`);
                            // Saltar el envío de notificación desde aquí
                            throw new Error('SKIP_NOTIFICATION');
                        }

                        await notifyShiftEnded(
                            branch_id,
                            employee.global_id,
                            {
                                employeeName: employee.full_name,
                                branchName: branch.name,
                                difference,
                                countedCash,
                                expectedCash
                            }
                        );

                        console.log(`[Sync/Shifts] ✅ Notificaciones de cierre enviadas para ${employee.full_name}`);
                    }
                } catch (notifError) {
                    if (notifError.message === 'SKIP_NOTIFICATION') {
                        // Normal: esperando que cash-cuts.js envíe la notificación
                        console.log(`[Sync/Shifts] ℹ️ Notificación se enviará cuando se sincronice el cash_cut`);
                    } else {
                        console.error(`[Sync/Shifts] ⚠️ Error enviando notificaciones de cierre: ${notifError.message}`);
                    }
                    // No fallar la sincronización si falla el envío de notificaciones
                }

                // 🧹 AUTO-ELIMINAR GASTOS HUÉRFANOS DE MÓVIL PARA ESTE TURNO CERRADO
                // Si el turno se cerró (probablemente offline), cualquier gasto móvil
                // pendiente de revisión debe ser eliminado porque el turno ya está cerrado
                try {
                    const deleteResult = await pool.query(`
                        DELETE FROM expenses
                        WHERE id_turno = $1
                          AND reviewed_by_desktop = false
                          AND (local_op_seq IS NULL OR local_op_seq = 0)
                        RETURNING id, global_id, amount, description
                    `, [shift.id]);

                    if (deleteResult.rows.length > 0) {
                        console.log(`[Sync/Shifts] 🧹 Auto-eliminados ${deleteResult.rows.length} gastos móviles huérfanos:`);
                        deleteResult.rows.forEach(exp => {
                            console.log(`  - Gasto ${exp.id} (${exp.global_id}): $${exp.amount} - ${exp.description}`);
                        });
                    }
                } catch (deleteError) {
                    console.error(`[Sync/Shifts] ⚠️ Error auto-eliminando gastos: ${deleteError.message}`);
                    // No fallar la sincronización
                }
            }

            res.json({
                success: true,
                data: {
                    id: shift.id,  // RemoteId para Desktop
                    global_id: shift.global_id,
                    local_shift_id: local_shift_id,  // Devolver para mapeo
                    created_at: shift.created_at
                }
            });

        } catch (error) {
            console.error('[Sync/Shifts] ❌ Error:', error.message);
            res.status(500).json({
                success: false,
                message: 'Error al sincronizar turno',
                error: undefined
            });
        }
    });

    // ============================================================================
    // POST /api/shifts/sync/close - Cierre de turno OFFLINE-FIRST (sin JWT)
    // Usa global_id para identificar el turno (idempotente)
    // ============================================================================
    router.post('/sync/close', async (req, res) => {
        try {
            const {
                tenant_id,
                global_id,
                end_time,
                final_amount,
                is_cash_cut_open,
                transaction_counter,
                // Datos para notificaciones
                employee_name,
                branch_name,
                counted_cash,
                expected_cash,
                difference
            } = req.body;

            console.log(`[Shifts/SyncClose] 🔒 POST /api/shifts/sync/close`);
            console.log(`  - tenant_id: ${tenant_id}, global_id: ${global_id}`);
            console.log(`  - end_time: ${end_time}, final_amount: ${final_amount}`);
            console.log(`  - is_cash_cut_open: ${is_cash_cut_open}`);

            // Validar campos requeridos
            if (!tenant_id || !global_id) {
                return res.status(400).json({
                    success: false,
                    message: 'tenant_id y global_id son requeridos'
                });
            }

            // Buscar el turno por global_id
            const shiftCheck = await pool.query(
                `SELECT id, employee_id, branch_id, is_cash_cut_open, global_id
                 FROM shifts
                 WHERE global_id = $1 AND tenant_id = $2`,
                [global_id, tenant_id]
            );

            if (shiftCheck.rows.length === 0) {
                console.log(`[Shifts/SyncClose] ⚠️ Turno no encontrado: ${global_id}`);
                return res.status(404).json({
                    success: false,
                    message: 'Turno no encontrado con ese global_id'
                });
            }

            const existingShift = shiftCheck.rows[0];

            // Si ya está cerrado, retornar éxito (idempotente)
            if (!existingShift.is_cash_cut_open) {
                console.log(`[Shifts/SyncClose] ℹ️ Turno ${global_id} ya estaba cerrado - operación idempotente`);
                return res.json({
                    success: true,
                    data: existingShift,
                    message: 'Turno ya estaba cerrado (idempotente)'
                });
            }

            // Cerrar el turno
            const result = await pool.query(`
                UPDATE shifts
                SET
                    end_time = $1,
                    final_amount = $2,
                    is_cash_cut_open = $3,
                    transaction_counter = COALESCE($4, transaction_counter),
                    updated_at = NOW()
                WHERE global_id = $5 AND tenant_id = $6
                RETURNING id, global_id, employee_id, branch_id, end_time, final_amount,
                          is_cash_cut_open, transaction_counter
            `, [
                end_time || new Date().toISOString(),
                final_amount || 0,
                is_cash_cut_open ?? false,
                transaction_counter,
                global_id,
                tenant_id
            ]);

            if (result.rows.length === 0) {
                return res.status(500).json({
                    success: false,
                    message: 'Error al actualizar turno'
                });
            }

            const closedShift = result.rows[0];
            console.log(`[Shifts/SyncClose] ✅ Turno ${global_id} cerrado exitosamente (PostgreSQL ID: ${closedShift.id})`);

            // 📢 EMITIR EVENTO SOCKET.IO: shift_ended
            if (io) {
                const roomName = `branch_${closedShift.branch_id}`;
                console.log(`[Shifts/SyncClose] 📡 Emitiendo 'shift_ended' a ${roomName}`);
                io.to(roomName).emit('shift_ended', {
                    shiftId: closedShift.id,
                    globalId: closedShift.global_id,
                    employeeId: closedShift.employee_id,
                    employeeName: employee_name || 'Empleado',
                    branchId: closedShift.branch_id,
                    branchName: branch_name || 'Sucursal',
                    endTime: closedShift.end_time,
                    finalAmount: parseFloat(closedShift.final_amount || 0),
                    countedCash: parseFloat(counted_cash || 0),
                    expectedCash: parseFloat(expected_cash || 0),
                    difference: parseFloat(difference || 0),
                    source: 'desktop_sync_close'
                });
            }

            res.json({
                success: true,
                data: closedShift,
                message: 'Turno cerrado exitosamente'
            });

        } catch (error) {
            console.error('[Shifts/SyncClose] ❌ Error:', error.message);
            res.status(500).json({
                success: false,
                message: 'Error al cerrar turno',
                error: undefined
            });
        }
    });

    // ============================================================================
    // GET /api/shifts/sync/status - Verificar estado de un turno por global_id
    // Para verificación post-reconexión (offline-first)
    // ============================================================================
    router.get('/sync/status', async (req, res) => {
        try {
            const { tenant_id, global_id, employee_global_id } = req.query;

            console.log(`[Shifts/SyncStatus] 🔍 GET /api/shifts/sync/status`);
            console.log(`  - tenant_id: ${tenant_id}, global_id: ${global_id || 'N/A'}`);
            console.log(`  - employee_global_id: ${employee_global_id || 'N/A'}`);

            if (!tenant_id) {
                return res.status(400).json({
                    success: false,
                    message: 'tenant_id es requerido'
                });
            }

            let result;

            // Si se proporciona global_id, buscar turno específico
            if (global_id) {
                result = await pool.query(`
                    SELECT
                        s.id, s.global_id, s.employee_id, s.branch_id,
                        s.start_time, s.end_time, s.is_cash_cut_open,
                        s.initial_amount, s.final_amount, s.updated_at,
                        CONCAT(e.first_name, ' ', e.last_name) as employee_name
                    FROM shifts s
                    LEFT JOIN employees e ON s.employee_id = e.id
                    WHERE s.global_id = $1 AND s.tenant_id = $2
                `, [global_id, tenant_id]);

                if (result.rows.length === 0) {
                    console.log(`[Shifts/SyncStatus] ⚠️ Turno no encontrado: ${global_id}`);
                    return res.json({
                        success: true,
                        found: false,
                        message: 'Turno no encontrado en servidor'
                    });
                }

                const shift = result.rows[0];
                console.log(`[Shifts/SyncStatus] ✅ Turno encontrado: ${global_id} - is_cash_cut_open: ${shift.is_cash_cut_open}`);

                return res.json({
                    success: true,
                    found: true,
                    data: {
                        id: shift.id,
                        global_id: shift.global_id,
                        employee_id: shift.employee_id,
                        employee_name: shift.employee_name,
                        branch_id: shift.branch_id,
                        start_time: shift.start_time,
                        end_time: shift.end_time,
                        is_cash_cut_open: shift.is_cash_cut_open,
                        initial_amount: parseFloat(shift.initial_amount || 0),
                        final_amount: shift.final_amount ? parseFloat(shift.final_amount) : null,
                        updated_at: shift.updated_at
                    }
                });
            }

            // Si se proporciona employee_global_id, buscar turno activo del empleado
            if (employee_global_id) {
                // Primero resolver employee_global_id a employee_id
                const empResult = await pool.query(
                    `SELECT id FROM employees WHERE global_id = $1 AND tenant_id = $2`,
                    [employee_global_id, tenant_id]
                );

                if (empResult.rows.length === 0) {
                    return res.json({
                        success: true,
                        found: false,
                        message: 'Empleado no encontrado'
                    });
                }

                const employeeId = empResult.rows[0].id;

                result = await pool.query(`
                    SELECT
                        s.id, s.global_id, s.employee_id, s.branch_id,
                        s.start_time, s.end_time, s.is_cash_cut_open,
                        s.initial_amount, s.final_amount, s.updated_at,
                        CONCAT(e.first_name, ' ', e.last_name) as employee_name
                    FROM shifts s
                    LEFT JOIN employees e ON s.employee_id = e.id
                    WHERE s.employee_id = $1 AND s.tenant_id = $2 AND s.is_cash_cut_open = true
                    ORDER BY s.start_time DESC
                    LIMIT 1
                `, [employeeId, tenant_id]);

                if (result.rows.length === 0) {
                    return res.json({
                        success: true,
                        found: false,
                        has_active_shift: false,
                        message: 'No hay turno activo para este empleado'
                    });
                }

                const shift = result.rows[0];
                return res.json({
                    success: true,
                    found: true,
                    has_active_shift: true,
                    data: {
                        id: shift.id,
                        global_id: shift.global_id,
                        employee_id: shift.employee_id,
                        employee_name: shift.employee_name,
                        branch_id: shift.branch_id,
                        start_time: shift.start_time,
                        end_time: shift.end_time,
                        is_cash_cut_open: shift.is_cash_cut_open,
                        initial_amount: parseFloat(shift.initial_amount || 0),
                        final_amount: shift.final_amount ? parseFloat(shift.final_amount) : null,
                        updated_at: shift.updated_at
                    }
                });
            }

            return res.status(400).json({
                success: false,
                message: 'Se requiere global_id o employee_global_id'
            });

        } catch (error) {
            console.error('[Shifts/SyncStatus] ❌ Error:', error.message);
            res.status(500).json({
                success: false,
                message: 'Error al verificar estado del turno',
                error: undefined
            });
        }
    });

    // ============================================================================
    // PUT /api/shifts/:id/close - Cerrar turno (llamado por Desktop) - LEGACY
    // ============================================================================
    router.put('/:id/close', authenticateToken, async (req, res) => {
        try {
            const { id } = req.params;
            const { tenantId } = req.user;
            const { end_time, closed_at } = req.body;

            console.log(`[Shifts/Close] PUT /api/shifts/${id}/close - Tenant: ${tenantId}`);

            // Usar end_time o closed_at (Desktop puede enviar cualquiera)
            const closeTime = end_time || closed_at;

            if (!closeTime) {
                return res.status(400).json({
                    success: false,
                    message: 'Se requiere end_time o closed_at'
                });
            }

            // Verificar que el turno pertenece al tenant
            const shiftCheck = await pool.query(
                `SELECT id, tenant_id, employee_id, branch_id FROM shifts WHERE id = $1`,
                [id]
            );

            if (shiftCheck.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Turno no encontrado'
                });
            }

            if (shiftCheck.rows[0].tenant_id !== tenantId) {
                return res.status(403).json({
                    success: false,
                    message: 'No autorizado para cerrar este turno'
                });
            }

            // Actualizar el turno
            const result = await pool.query(`
                UPDATE shifts
                SET
                    closed_at = $1,
                    is_cash_cut_open = false,
                    updated_at = NOW()
                WHERE id = $2 AND tenant_id = $3
                RETURNING id, employee_id, branch_id, closed_at, is_cash_cut_open
            `, [closeTime, id, tenantId]);

            if (result.rows.length === 0) {
                return res.status(500).json({
                    success: false,
                    message: 'Error al actualizar turno'
                });
            }

            console.log(`[Shifts/Close] ✅ Turno ${id} cerrado exitosamente`);

            // 🔌 EMIT Socket.IO para actualizar app móvil en tiempo real
            const closedShift = result.rows[0];
            if (io && closedShift.branch_id) {
                const roomName = `branch_${closedShift.branch_id}`;
                console.log(`[Shifts/Close] 📡 Emitiendo 'shift_ended' a ${roomName}`);
                io.to(roomName).emit('shift_ended', {
                    shiftId: closedShift.id,
                    employeeId: closedShift.employee_id,
                    branchId: closedShift.branch_id,
                    endTime: closeTime,
                    source: 'put_close'
                });
            }

            res.json({
                success: true,
                message: 'Turno cerrado exitosamente',
                data: closedShift
            });

        } catch (error) {
            console.error('[Shifts/Close] ❌ Error:', error.message);
            res.status(500).json({
                success: false,
                message: 'Error al cerrar turno',
                error: undefined
            });
        }
    });

    // GET /api/shifts/cash-snapshots/open - Calcular snapshots de turnos abiertos en tiempo real
    router.get('/cash-snapshots/open', authenticateToken, async (req, res) => {
        try {
            const { tenantId, branchId } = req.user;
            const { all_branches = 'false', date } = req.query;

            console.log('[Shifts/CashSnapshots] 📊 Calculando snapshots de turnos abiertos...');
            console.log('[Shifts/CashSnapshots] 🏢 Tenant:', tenantId, '| Branch:', branchId);
            console.log('[Shifts/CashSnapshots] 🌐 All branches:', all_branches, '| Date:', date);

            // Construir query para obtener turnos abiertos
            let query = `
                SELECT
                    s.id, s.employee_id, s.branch_id, s.tenant_id,
                    s.start_time, s.initial_amount, s.is_cash_cut_open,
                    CONCAT(e.first_name, ' ', e.last_name) as employee_name,
                    r.name as employee_role,
                    b.name as branch_name
                FROM shifts s
                INNER JOIN employees e ON s.employee_id = e.id
                INNER JOIN roles r ON e.role_id = r.id
                INNER JOIN branches b ON s.branch_id = b.id
                WHERE s.tenant_id = $1
                  AND s.is_cash_cut_open = true
            `;

            const params = [tenantId];

            // Filtrar por sucursal si no se solicitan todas
            if (all_branches !== 'true') {
                query += ` AND s.branch_id = $${params.length + 1}`;
                params.push(branchId);
            }

            // Filtrar por fecha si se proporciona
            if (date) {
                query += ` AND DATE(s.start_time) = DATE($${params.length + 1})`;
                params.push(date);
            }

            query += ` ORDER BY s.start_time DESC`;

            const shiftsResult = await pool.query(query, params);
            const openShifts = shiftsResult.rows;

            console.log('[Shifts/CashSnapshots] ✅ Turnos abiertos encontrados:', openShifts.length);

            // Para cada turno abierto, calcular su snapshot desde las tablas
            const snapshots = [];

            for (const shift of openShifts) {
                try {
                    const isRepartidor = shift.employee_role.toLowerCase() === 'repartidor';

                    // 1. Calcular ventas por método de pago
                    // IMPORTANTE: Excluir ventas asignadas a repartidores (id_turno_repartidor != null)
                    // porque ese dinero NO está en la caja del empleado de mostrador
                    // tipo_pago_id: 1=Efectivo, 2=Tarjeta, 3=Crédito, 4=Mixto
                    const salesQuery = await pool.query(`
                        SELECT
                            COALESCE(SUM(
                                CASE
                                    WHEN tipo_pago_id = 4 THEN cash_amount
                                    WHEN tipo_pago_id = 1 THEN total
                                    ELSE 0
                                END
                            ), 0) as cash_sales,
                            COALESCE(SUM(
                                CASE
                                    WHEN tipo_pago_id = 4 THEN card_amount
                                    WHEN tipo_pago_id = 2 THEN total
                                    ELSE 0
                                END
                            ), 0) as card_sales,
                            COALESCE(SUM(
                                CASE
                                    WHEN tipo_pago_id = 4 THEN credit_amount
                                    WHEN tipo_pago_id = 3 THEN total
                                    ELSE 0
                                END
                            ), 0) as credit_sales
                        FROM ventas
                        WHERE id_turno = $1
                          AND id_turno_repartidor IS NULL
                    `, [shift.id]);

                    // 2. Calcular gastos (usa id_turno)
                    const expensesQuery = await pool.query(`
                        SELECT COALESCE(SUM(amount), 0) as total_expenses, COUNT(*) as expense_count
                        FROM expenses
                        WHERE id_turno = $1
                    `, [shift.id]);

                    // 3. Calcular depósitos (usa shift_id)
                    const depositsQuery = await pool.query(`
                        SELECT COALESCE(SUM(amount), 0) as total_deposits, COUNT(*) as deposit_count
                        FROM deposits
                        WHERE shift_id = $1
                    `, [shift.id]);

                    // 4. Calcular retiros (usa shift_id)
                    const withdrawalsQuery = await pool.query(`
                        SELECT COALESCE(SUM(amount), 0) as total_withdrawals, COUNT(*) as withdrawal_count
                        FROM withdrawals
                        WHERE shift_id = $1
                    `, [shift.id]);

                    // 5. Calcular pagos de clientes (credit_payments)
                    const paymentsQuery = await pool.query(`
                        SELECT
                            COALESCE(SUM(CASE WHEN payment_method = 'cash' THEN amount ELSE 0 END), 0) as cash_payments,
                            COALESCE(SUM(CASE WHEN payment_method = 'card' THEN amount ELSE 0 END), 0) as card_payments,
                            COUNT(*) as payment_count
                        FROM credit_payments
                        WHERE shift_id = $1
                    `, [shift.id]);

                    const sales = salesQuery.rows[0];
                    const expenses = expensesQuery.rows[0];
                    const deposits = depositsQuery.rows[0];
                    const withdrawals = withdrawalsQuery.rows[0];
                    const payments = paymentsQuery.rows[0];

                    const initialAmount = parseFloat(shift.initial_amount || 0);
                    const cashSales = parseFloat(sales.cash_sales || 0);
                    const cardSales = parseFloat(sales.card_sales || 0);
                    const creditSales = parseFloat(sales.credit_sales || 0);
                    const totalExpenses = parseFloat(expenses.total_expenses || 0);
                    const totalDeposits = parseFloat(deposits.total_deposits || 0);
                    const totalWithdrawals = parseFloat(withdrawals.total_withdrawals || 0);
                    const cashPayments = parseFloat(payments.cash_payments || 0);
                    const cardPayments = parseFloat(payments.card_payments || 0);

                    // 6. Calcular liquidaciones de repartidores recibidas durante este turno (solo para cajeros)
                    // IMPORTANTE: Solo incluir si cajero_consolida_liquidaciones = true en la sucursal
                    let liquidacionesEfectivo = 0;
                    let liquidacionesTarjeta = 0;
                    let liquidacionesCredito = 0;
                    let totalRepartidorExpenses = 0;
                    let hasConsolidatedLiquidaciones = false;
                    let consolidatedRepartidorNames = null;

                    // Verificar si la sucursal tiene modo consolidación activo
                    let cajeroConsolidaSnapshot = false;
                    try {
                        const branchSettingSnap = await pool.query(
                            'SELECT cajero_consolida_liquidaciones FROM branches WHERE id = $1',
                            [shift.branch_id]
                        );
                        cajeroConsolidaSnapshot = branchSettingSnap.rows[0]?.cajero_consolida_liquidaciones === true;
                    } catch (settingErr) {
                        console.warn(`[Shifts/Snapshot] ⚠️ Error leyendo setting de branch: ${settingErr.message}`);
                    }

                    if (!isRepartidor && cajeroConsolidaSnapshot) {
                        // Obtener desglose de ventas de repartidores liquidadas por tipo de pago
                        // IMPORTANTE: Usar subquery con DISTINCT para evitar contar duplicados
                        // (una venta puede tener múltiples repartidor_assignments, uno por producto)
                        const liquidacionesQuery = await pool.query(`
                            SELECT
                                COALESCE(SUM(CASE
                                    WHEN v.tipo_pago_id = 4 THEN COALESCE(v.cash_amount, 0)
                                    WHEN v.tipo_pago_id = 1 THEN v.total
                                    ELSE 0
                                END), 0) as total_liquidaciones_efectivo,
                                COALESCE(SUM(CASE
                                    WHEN v.tipo_pago_id = 4 THEN COALESCE(v.card_amount, 0)
                                    WHEN v.tipo_pago_id = 2 THEN v.total
                                    ELSE 0
                                END), 0) as total_liquidaciones_tarjeta,
                                COALESCE(SUM(CASE
                                    WHEN v.tipo_pago_id = 4 THEN COALESCE(v.credit_amount, 0)
                                    WHEN v.tipo_pago_id = 3 THEN v.total
                                    ELSE 0
                                END), 0) as total_liquidaciones_credito
                            FROM ventas v
                            WHERE v.id_venta IN (
                                SELECT DISTINCT ra.venta_id
                                FROM repartidor_assignments ra
                                WHERE ra.status = 'liquidated'
                                  AND ra.fecha_liquidacion >= $1
                                  AND ra.venta_id IS NOT NULL
                            )
                              AND v.branch_id = $2
                              AND v.tenant_id = $3
                        `, [shift.start_time, shift.branch_id, shift.tenant_id]);

                        liquidacionesEfectivo = parseFloat(liquidacionesQuery.rows[0]?.total_liquidaciones_efectivo || 0);
                        liquidacionesTarjeta = parseFloat(liquidacionesQuery.rows[0]?.total_liquidaciones_tarjeta || 0);
                        liquidacionesCredito = parseFloat(liquidacionesQuery.rows[0]?.total_liquidaciones_credito || 0);

                        // Gastos de repartidores: leer de tabla expenses de turnos repartidores
                        const repartidorExpensesQuery = await pool.query(`
                            SELECT COALESCE(SUM(e.amount), 0) as total_repartidor_expenses
                            FROM expenses e
                            INNER JOIN shifts s ON e.id_turno = s.id
                            INNER JOIN employees emp ON s.employee_id = emp.id
                            INNER JOIN roles r ON emp.role_id = r.id
                            WHERE LOWER(r.name) = 'repartidor'
                              AND s.branch_id = $1
                              AND s.tenant_id = $2
                              AND s.start_time >= $3
                        `, [shift.branch_id, shift.tenant_id, shift.start_time]);

                        totalRepartidorExpenses = parseFloat(repartidorExpensesQuery.rows[0]?.total_repartidor_expenses || 0);

                        // Obtener nombres de repartidores para UI
                        if (liquidacionesEfectivo > 0 || liquidacionesTarjeta > 0 || liquidacionesCredito > 0) {
                            hasConsolidatedLiquidaciones = true;
                            const namesQuery = await pool.query(`
                                SELECT STRING_AGG(DISTINCT CONCAT(e.first_name, ' ', e.last_name), ', ') as repartidor_names
                                FROM repartidor_liquidations rl
                                LEFT JOIN employees e ON e.id = rl.employee_id
                                WHERE rl.branch_id = $1
                                  AND rl.tenant_id = $2
                                  AND rl.fecha_liquidacion >= $3
                            `, [shift.branch_id, shift.tenant_id, shift.start_time]);
                            consolidatedRepartidorNames = namesQuery.rows[0]?.repartidor_names || null;
                        }
                    }

                    // Efectivo esperado = inicial + ventas efectivo + pagos efectivo + liquidaciones efectivo + depósitos - gastos - retiros - gastos repartidores
                    const expectedCash = initialAmount + cashSales + cashPayments + liquidacionesEfectivo + totalDeposits - totalExpenses - totalWithdrawals - totalRepartidorExpenses;

                    let snapshotData = {
                        // Info del turno
                        shift_id: shift.id,
                        employee_id: shift.employee_id,
                        employee_name: shift.employee_name,
                        employee_role: shift.employee_role,
                        branch_id: shift.branch_id,
                        branch_name: shift.branch_name,
                        tenant_id: shift.tenant_id,
                        start_time: shift.start_time,

                        // Montos básicos
                        initial_amount: initialAmount,
                        cash_sales: cashSales,
                        card_sales: cardSales,
                        credit_sales: creditSales,
                        cash_payments: cashPayments,
                        card_payments: cardPayments,
                        expenses: totalExpenses,
                        deposits: totalDeposits,
                        withdrawals: totalWithdrawals,
                        liquidaciones_efectivo: liquidacionesEfectivo,
                        total_repartidor_expenses: totalRepartidorExpenses,
                        has_consolidated_liquidaciones: hasConsolidatedLiquidaciones,
                        consolidated_repartidor_names: consolidatedRepartidorNames,
                        cajero_consolida_liquidaciones: cajeroConsolidaSnapshot,
                        expected_cash: expectedCash,

                        // Contadores básicos
                        expense_count: parseInt(expenses.expense_count || 0),
                        deposit_count: parseInt(deposits.deposit_count || 0),
                        withdrawal_count: parseInt(withdrawals.withdrawal_count || 0),

                        // Valores por defecto para no-repartidores
                        total_assigned_amount: 0,
                        total_assigned_quantity: 0,
                        total_returned_amount: 0,
                        total_returned_quantity: 0,
                        net_amount_to_deliver: 0,
                        net_quantity_delivered: 0,
                        actual_cash_delivered: 0,
                        cash_difference: 0,
                        assignment_count: 0,
                        liquidated_assignment_count: 0,
                        return_count: 0,
                        last_updated_at: new Date().toISOString(),
                    };

                    // Si es repartidor, calcular asignaciones y devoluciones
                    if (isRepartidor) {
                        // 5. Calcular asignaciones del repartidor
                        const assignmentsQuery = await pool.query(`
                            SELECT
                                COUNT(*) as total_assignments,
                                COUNT(*) FILTER (WHERE status = 'liquidated') as liquidated_assignments,
                                COALESCE(SUM(assigned_amount), 0) as total_assigned_amt,
                                COALESCE(SUM(assigned_quantity), 0) as total_assigned_qty
                            FROM repartidor_assignments
                            WHERE repartidor_shift_id = $1
                              AND status != 'cancelled'
                        `, [shift.id]);

                        // 6. Calcular devoluciones del repartidor
                        const returnsQuery = await pool.query(`
                            SELECT
                                COUNT(*) as total_returns,
                                COALESCE(SUM(rr.amount), 0) as total_returned_amt,
                                COALESCE(SUM(rr.quantity), 0) as total_returned_qty
                            FROM repartidor_returns rr
                            INNER JOIN repartidor_assignments ra ON ra.id = rr.assignment_id
                            WHERE ra.repartidor_shift_id = $1
                        `, [shift.id]);

                        const assignments = assignmentsQuery.rows[0];
                        const returns = returnsQuery.rows[0];

                        const totalAssignedAmount = parseFloat(assignments.total_assigned_amt || 0);
                        const totalAssignedQty = parseFloat(assignments.total_assigned_qty || 0);
                        const totalReturnedAmount = parseFloat(returns.total_returned_amt || 0);
                        const totalReturnedQty = parseFloat(returns.total_returned_qty || 0);

                        // Dinero neto que debe entregar = asignado - devuelto
                        const netAmountToDeliver = totalAssignedAmount - totalReturnedAmount;
                        const netQuantityDelivered = totalAssignedQty - totalReturnedQty;

                        // Actualizar snapshot con datos de repartidor
                        snapshotData.total_assigned_amount = totalAssignedAmount;
                        snapshotData.total_assigned_quantity = totalAssignedQty;
                        snapshotData.total_returned_amount = totalReturnedAmount;
                        snapshotData.total_returned_quantity = totalReturnedQty;
                        snapshotData.net_amount_to_deliver = netAmountToDeliver;
                        snapshotData.net_quantity_delivered = netQuantityDelivered;
                        snapshotData.assignment_count = parseInt(assignments.total_assignments || 0);
                        snapshotData.liquidated_assignment_count = parseInt(assignments.liquidated_assignments || 0);
                        snapshotData.return_count = parseInt(returns.total_returns || 0);

                        // Ventas en efectivo para repartidores = asignaciones liquidadas - devoluciones
                        // (sobreescribir el cálculo anterior)
                        snapshotData.cash_sales = netAmountToDeliver;
                        snapshotData.expected_cash = initialAmount + netAmountToDeliver + cashPayments + totalDeposits - totalExpenses - totalWithdrawals;

                        // TODO: Obtener actual_cash_delivered si ya liquidó
                        // Por ahora dejamos en 0, se actualizará cuando liquide
                    }

                    snapshots.push(snapshotData);

                } catch (shiftError) {
                    console.error(`[Shifts/CashSnapshots] ❌ Error procesando shift ${shift.id}:`, shiftError.message);
                    // Continuar con el siguiente turno
                }
            }

            console.log('[Shifts/CashSnapshots] ✅ Snapshots calculados:', snapshots.length);

            res.json({
                success: true,
                count: snapshots.length,
                data: snapshots
            });

        } catch (error) {
            console.error('[Shifts/CashSnapshots] ❌ Error:', error.message);
            res.status(500).json({
                success: false,
                message: 'Error al calcular snapshots de caja',
                error: undefined
            });
        }
    });

    return router;
};
