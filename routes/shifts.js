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
                // 1. Calcular ventas por método de pago (tipo_pago_id: 1=Efectivo, 2=Tarjeta, 3=Crédito)
                // IMPORTANTE: Excluir ventas asignadas a repartidores (id_turno_repartidor != null)
                const salesResult = await pool.query(`
                    SELECT
                        COALESCE(SUM(CASE WHEN tipo_pago_id = 1 THEN total ELSE 0 END), 0) as total_cash_sales,
                        COALESCE(SUM(CASE WHEN tipo_pago_id = 2 THEN total ELSE 0 END), 0) as total_card_sales,
                        COALESCE(SUM(CASE WHEN tipo_pago_id = 3 THEN total ELSE 0 END), 0) as total_credit_sales
                    FROM ventas
                    WHERE id_turno = $1
                      AND id_turno_repartidor IS NULL
                `, [shift.id]);

                // 2. Calcular gastos
                const expensesResult = await pool.query(`
                    SELECT COALESCE(SUM(amount), 0) as total_expenses
                    FROM expenses
                    WHERE id_turno = $1
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

                enrichedShifts.push({
                    ...shift,
                    start_time: shift.start_time ? new Date(shift.start_time).toISOString() : null,
                    end_time: shift.end_time ? new Date(shift.end_time).toISOString() : null,
                    created_at: shift.created_at ? new Date(shift.created_at).toISOString() : null,
                    updated_at: shift.updated_at ? new Date(shift.updated_at).toISOString() : null,
                    total_cash_sales: parseFloat(salesResult.rows[0]?.total_cash_sales || 0),
                    total_card_sales: parseFloat(salesResult.rows[0]?.total_card_sales || 0),
                    total_credit_sales: parseFloat(salesResult.rows[0]?.total_credit_sales || 0),
                    total_expenses: parseFloat(expensesResult.rows[0]?.total_expenses || 0),
                    total_deposits: parseFloat(depositsResult.rows[0]?.total_deposits || 0),
                    total_withdrawals: parseFloat(withdrawalsResult.rows[0]?.total_withdrawals || 0),
                    total_cash_payments: parseFloat(paymentsResult.rows[0]?.total_cash_payments || 0),
                    total_card_payments: parseFloat(paymentsResult.rows[0]?.total_card_payments || 0),
                    // 🚚 Asignaciones de repartidor (DOS contadores diferentes)
                    created_assignments: parseInt(createdAssignmentsResult.rows[0]?.created_assignments || 0),
                    received_assignments: parseInt(receivedAssignmentsResult.rows[0]?.received_assignments || 0),
                });
            }

            res.json({
                success: true,
                data: enrichedShifts
            });

        } catch (error) {
            console.error('[Shifts] Error al obtener historial:', error);
            res.status(500).json({ success: false, message: 'Error al obtener historial de turnos' });
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
                await pool.query(
                    `UPDATE shifts SET end_time = CURRENT_TIMESTAMP, is_cash_cut_open = false
                     WHERE id = $1`,
                    [oldShift.id]
                );

                console.log(`[Sync/Shifts] ✅ Shift ${oldShift.id} auto-cerrado por sincronización offline`);
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
                error: error.message
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
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::uuid, $11::uuid, $12, $13, $14)
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
                error: error.message
            });
        }
    });

    // ============================================================================
    // PUT /api/shifts/:id/close - Cerrar turno (llamado por Desktop)
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

            res.json({
                success: true,
                message: 'Turno cerrado exitosamente',
                data: result.rows[0]
            });

        } catch (error) {
            console.error('[Shifts/Close] ❌ Error:', error.message);
            res.status(500).json({
                success: false,
                message: 'Error al cerrar turno',
                error: error.message
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
                    // tipo_pago_id: 1=Efectivo, 2=Tarjeta, 3=Crédito
                    // IMPORTANTE: Excluir ventas asignadas a repartidores (id_turno_repartidor != null)
                    // porque ese dinero NO está en la caja del empleado de mostrador
                    const salesQuery = await pool.query(`
                        SELECT
                            COALESCE(SUM(CASE WHEN tipo_pago_id = 1 THEN total ELSE 0 END), 0) as cash_sales,
                            COALESCE(SUM(CASE WHEN tipo_pago_id = 2 THEN total ELSE 0 END), 0) as card_sales,
                            COALESCE(SUM(CASE WHEN tipo_pago_id = 3 THEN total ELSE 0 END), 0) as credit_sales
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

                    // Efectivo esperado = inicial + ventas efectivo + pagos efectivo + depósitos - gastos - retiros
                    const expectedCash = initialAmount + cashSales + cashPayments + totalDeposits - totalExpenses - totalWithdrawals;

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
                error: error.message
            });
        }
    });

    return router;
};
