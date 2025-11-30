// routes/repartidores.js
const express = require('express');
const router = express.Router();

// Middleware para validar JWT token
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ success: false, message: 'Token no proporcionado' });
    }

    const jwt = require('jsonwebtoken');
    jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key', (err, user) => {
        if (err) {
            return res.status(403).json({ success: false, message: 'Token inválido' });
        }
        req.user = user;
        next();
    });
}

module.exports = (pool) => {
    // GET /api/repartidores/summary - Resumen de todos los repartidores con asignaciones
    router.get('/summary', authenticateToken, async (req, res) => {
        try {
            const { tenantId, branchId: userBranchId } = req.user;
            const { all_branches = 'false', branch_id, shift_id, only_open_shifts = 'false' } = req.query;

            // Prioridad: 1. branch_id del query, 2. branchId del JWT
            const targetBranchId = branch_id ? parseInt(branch_id) : userBranchId;

            console.log(`[Repartidores Summary] Fetching - Tenant: ${tenantId}, Branch: ${targetBranchId}, Shift: ${shift_id || 'ALL'}, all_branches: ${all_branches}, Only Open Shifts: ${only_open_shifts}`);

            let query = `
                WITH assignment_stats AS (
                    SELECT
                        ra.employee_id,
                        CONCAT(e.first_name, ' ', e.last_name) as repartidor_name,
                        e.role_id,
                        r.name as role_name,

                        -- Asignaciones pendientes
                        SUM(CASE WHEN ra.status = 'pending' THEN ra.assigned_quantity ELSE 0 END) as pending_quantity,
                        SUM(CASE WHEN ra.status = 'pending' THEN ra.assigned_amount ELSE 0 END) as pending_amount,

                        -- Asignaciones en progreso
                        SUM(CASE WHEN ra.status = 'in_progress' THEN ra.assigned_quantity ELSE 0 END) as in_progress_quantity,
                        SUM(CASE WHEN ra.status = 'in_progress' THEN ra.assigned_amount ELSE 0 END) as in_progress_amount,

                        -- Asignaciones liquidadas
                        SUM(CASE WHEN ra.status = 'liquidated' THEN ra.assigned_quantity ELSE 0 END) as liquidated_quantity,
                        SUM(CASE WHEN ra.status = 'liquidated' THEN ra.assigned_amount ELSE 0 END) as liquidated_amount,

                        -- Totales
                        COUNT(*) as total_assignments,
                        COUNT(CASE WHEN ra.status = 'pending' THEN 1 END) as pending_count,
                        COUNT(CASE WHEN ra.status = 'in_progress' THEN 1 END) as in_progress_count,
                        COUNT(CASE WHEN ra.status = 'liquidated' THEN 1 END) as liquidated_count,
                        COUNT(CASE WHEN ra.status = 'cancelled' THEN 1 END) as cancelled_count,

                        MAX(ra.fecha_asignacion) as last_assignment_date
                    FROM repartidor_assignments ra
                    LEFT JOIN employees e ON ra.employee_id = e.id
                    LEFT JOIN roles r ON e.role_id = r.id
                    LEFT JOIN shifts s ON ra.repartidor_shift_id = s.id
                    WHERE ra.tenant_id = $1
            `;

            // Solo filtrar por turnos abiertos si se especifica explícitamente
            if (only_open_shifts === 'true') {
                query += ` AND (s.id IS NULL OR s.is_cash_cut_open = true)`;
            }

            const params = [tenantId];
            let paramIndex = 2;

            // Filtrar por branch
            if (all_branches !== 'true' && targetBranchId) {
                query += ` AND ra.branch_id = $${paramIndex}`;
                params.push(targetBranchId);
                paramIndex++;
            }

            // Filtrar por shift_id (turno del administrador que asignó)
            if (shift_id) {
                query += ` AND ra.shift_id = $${paramIndex}`;
                params.push(parseInt(shift_id));
                paramIndex++;
            }

            query += `
                    GROUP BY ra.employee_id, e.first_name, e.last_name, e.role_id, r.name
                ),
                returns_stats AS (
                    SELECT
                        ra.employee_id,
                        SUM(rr.quantity) as total_returned_quantity,
                        SUM(rr.amount) as total_returned_amount,
                        COUNT(rr.id) as return_count
                    FROM repartidor_returns rr
                    INNER JOIN repartidor_assignments ra ON rr.assignment_id = ra.id
                    WHERE rr.tenant_id = $1
            `;

            // Repetir filtros para returns
            let returnsParamIndex = 2;
            if (all_branches !== 'true' && targetBranchId) {
                query += ` AND rr.branch_id = $${returnsParamIndex}`;
                returnsParamIndex++;
            }
            if (shift_id) {
                query += ` AND rr.shift_id = $${returnsParamIndex}`;
                returnsParamIndex++;
            }

            query += `
                    GROUP BY ra.employee_id
                )
                SELECT
                    a.*,
                    COALESCE(rs.total_returned_quantity, 0) as total_returned_quantity,
                    COALESCE(rs.total_returned_amount, 0) as total_returned_amount,
                    COALESCE(rs.return_count, 0) as return_count,
                    (a.pending_quantity + a.in_progress_quantity) as active_quantity,
                    (a.pending_amount + a.in_progress_amount) as active_amount
                FROM assignment_stats a
                LEFT JOIN returns_stats rs ON a.employee_id = rs.employee_id
                ORDER BY a.last_assignment_date DESC
            `;

            const result = await pool.query(query, params);

            console.log(`[Repartidores Summary] ✅ Found ${result.rows.length} repartidores with assignments`);

            res.json({
                success: true,
                data: result.rows.map(row => ({
                    employee_id: row.employee_id,
                    repartidor_name: row.repartidor_name,
                    role_name: row.role_name,
                    pending_quantity: parseFloat(row.pending_quantity),
                    pending_amount: parseFloat(row.pending_amount),
                    in_progress_quantity: parseFloat(row.in_progress_quantity),
                    in_progress_amount: parseFloat(row.in_progress_amount),
                    liquidated_quantity: parseFloat(row.liquidated_quantity),
                    liquidated_amount: parseFloat(row.liquidated_amount),
                    active_quantity: parseFloat(row.active_quantity),
                    active_amount: parseFloat(row.active_amount),
                    total_returned_quantity: parseFloat(row.total_returned_quantity),
                    total_returned_amount: parseFloat(row.total_returned_amount),
                    total_assignments: parseInt(row.total_assignments),
                    pending_count: parseInt(row.pending_count),
                    in_progress_count: parseInt(row.in_progress_count),
                    liquidated_count: parseInt(row.liquidated_count),
                    cancelled_count: parseInt(row.cancelled_count),
                    return_count: parseInt(row.return_count),
                    last_assignment_date: row.last_assignment_date
                }))
            });
        } catch (error) {
            console.error('[Repartidores Summary] Error:', error);
            res.status(500).json({ success: false, message: 'Error al obtener resumen de repartidores', error: error.message });
        }
    });

    // GET /api/repartidores/:employeeId/assignments - Asignaciones de un repartidor específico
    router.get('/:employeeId/assignments', authenticateToken, async (req, res) => {
        try {
            const { tenantId, branchId: userBranchId, employeeId: jwtEmployeeId } = req.user;
            const { employeeId } = req.params;
            const { status, limit = 50, offset = 0, only_open_shifts = 'false' } = req.query;

            console.log(`[Repartidor Assignments] 🔍 === REQUEST INFO ===`);
            console.log(`[Repartidor Assignments] JWT User: tenantId=${tenantId}, branchId=${userBranchId}, employeeId=${jwtEmployeeId}`);
            console.log(`[Repartidor Assignments] Params: employeeId=${employeeId} (from URL)`);
            console.log(`[Repartidor Assignments] Query: status=${status || 'ALL'}, only_open_shifts=${only_open_shifts}, limit=${limit}, offset=${offset}`);

            let query = `
                SELECT
                    ra.id,
                    ra.venta_id,
                    ra.employee_id,
                    ra.assigned_quantity,
                    ra.assigned_amount,
                    ra.unit_price,
                    ra.status,
                    ra.fecha_asignacion,
                    ra.fecha_liquidacion,
                    ra.observaciones,
                    ra.repartidor_shift_id,
                    CONCAT(e_created.first_name, ' ', e_created.last_name) as assigned_by_name,
                    v.ticket_number,
                    CONCAT(e_repartidor.first_name, ' ', e_repartidor.last_name) as repartidor_name,
                    s.is_cash_cut_open as shift_is_open
                FROM repartidor_assignments ra
                LEFT JOIN employees e_created ON ra.created_by_employee_id = e_created.id
                LEFT JOIN employees e_repartidor ON ra.employee_id = e_repartidor.id
                LEFT JOIN ventas v ON ra.venta_id = v.id_venta
                LEFT JOIN shifts s ON ra.repartidor_shift_id = s.id
                WHERE ra.tenant_id = $1 AND ra.employee_id = $2
            `;

            // Solo filtrar por turnos abiertos si se especifica explícitamente
            if (only_open_shifts === 'true') {
                query += ` AND (s.id IS NULL OR s.is_cash_cut_open = true)`;
                console.log(`[Repartidor Assignments] ✅ Filtrando solo turnos abiertos`);
            }

            const params = [tenantId, parseInt(employeeId)];
            let paramIndex = 3;

            // Filtrar por status si se proporciona
            if (status) {
                query += ` AND ra.status = $${paramIndex}`;
                params.push(status);
                paramIndex++;
            }

            query += ` ORDER BY ra.fecha_asignacion DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
            params.push(limit, offset);

            console.log(`[Repartidor Assignments] 📊 Executing query with params:`, params);
            const result = await pool.query(query, params);

            console.log(`[Repartidor Assignments] ✅ Found ${result.rows.length} assignments`);
            if (result.rows.length === 0) {
                console.log(`[Repartidor Assignments] ⚠️ No assignments found for employeeId=${employeeId}, tenantId=${tenantId}`);
                // Verificar si el empleado existe
                const empCheck = await pool.query('SELECT id, first_name, last_name, role_id FROM employees WHERE id = $1', [parseInt(employeeId)]);
                if (empCheck.rows.length === 0) {
                    console.log(`[Repartidor Assignments] ❌ Employee ID ${employeeId} does NOT exist in database`);
                } else {
                    console.log(`[Repartidor Assignments] ✅ Employee exists: ${empCheck.rows[0].first_name} ${empCheck.rows[0].last_name} (roleId: ${empCheck.rows[0].role_id})`);
                }
                // Verificar si hay asignaciones para este empleado (sin filtros)
                const allAssignments = await pool.query('SELECT id, status, repartidor_shift_id FROM repartidor_assignments WHERE employee_id = $1 LIMIT 5', [parseInt(employeeId)]);
                console.log(`[Repartidor Assignments] 📋 Total assignments in DB for this employee (unfiltered): ${allAssignments.rows.length}`);
                if (allAssignments.rows.length > 0) {
                    console.log(`[Repartidor Assignments] 📦 Sample assignments:`, allAssignments.rows);
                }
            } else {
                console.log(`[Repartidor Assignments] 📦 First assignment:`, {
                    id: result.rows[0].id,
                    status: result.rows[0].status,
                    quantity: result.rows[0].assigned_quantity,
                    shiftId: result.rows[0].repartidor_shift_id,
                    shiftIsOpen: result.rows[0].shift_is_open
                });
            }

            // Obtener los items de cada venta
            const ventaIds = result.rows.map(row => row.venta_id).filter(id => id != null);
            let itemsByVenta = {};

            if (ventaIds.length > 0) {
                const itemsQuery = `
                    SELECT
                        vd.id_venta,
                        vd.id_producto,
                        vd.descripcion_producto,
                        vd.cantidad,
                        vd.precio_unitario,
                        vd.total_linea
                    FROM ventas_detalle vd
                    WHERE vd.id_venta = ANY($1)
                    ORDER BY vd.id_venta, vd.id_venta_detalle
                `;
                const itemsResult = await pool.query(itemsQuery, [ventaIds]);

                // Agrupar items por venta_id
                itemsResult.rows.forEach(item => {
                    if (!itemsByVenta[item.id_venta]) {
                        itemsByVenta[item.id_venta] = [];
                    }
                    itemsByVenta[item.id_venta].push({
                        product_id: item.id_producto,
                        product_name: item.descripcion_producto,
                        quantity: parseFloat(item.cantidad),
                        unit_price: parseFloat(item.precio_unitario),
                        line_total: parseFloat(item.total_linea)
                    });
                });

                console.log(`[Repartidor Assignments] 📦 Loaded items for ${Object.keys(itemsByVenta).length} ventas`);
            }

            // 🆕 Obtener devoluciones por assignment_id
            const assignmentIds = result.rows.map(row => row.id);
            let returnsByAssignment = {};

            if (assignmentIds.length > 0) {
                const returnsQuery = `
                    SELECT
                        rr.assignment_id,
                        rr.quantity,
                        rr.amount,
                        rr.return_date,
                        rr.source,
                        rr.notes
                    FROM repartidor_returns rr
                    WHERE rr.assignment_id = ANY($1)
                    ORDER BY rr.return_date DESC
                `;
                const returnsResult = await pool.query(returnsQuery, [assignmentIds]);

                // Agrupar devoluciones por assignment_id
                returnsResult.rows.forEach(ret => {
                    if (!returnsByAssignment[ret.assignment_id]) {
                        returnsByAssignment[ret.assignment_id] = [];
                    }
                    returnsByAssignment[ret.assignment_id].push({
                        quantity: parseFloat(ret.quantity),
                        amount: parseFloat(ret.amount),
                        return_date: ret.return_date,
                        source: ret.source,
                        notes: ret.notes
                    });
                });

                console.log(`[Repartidor Assignments] 🔄 Loaded returns for ${Object.keys(returnsByAssignment).length} assignments`);
            }

            res.json({
                success: true,
                data: result.rows.map(row => {
                    const returns = returnsByAssignment[row.id] || [];
                    const totalReturnedQuantity = returns.reduce((sum, r) => sum + r.quantity, 0);
                    const totalReturnedAmount = returns.reduce((sum, r) => sum + r.amount, 0);

                    return {
                        id: row.id,
                        venta_id: row.venta_id,
                        ticket_number: row.ticket_number,
                        employee_id: row.employee_id,
                        repartidor_name: row.repartidor_name,
                        assigned_quantity: parseFloat(row.assigned_quantity),
                        assigned_amount: parseFloat(row.assigned_amount),
                        unit_price: parseFloat(row.unit_price),
                        status: row.status,
                        fecha_asignacion: row.fecha_asignacion,
                        fecha_liquidacion: row.fecha_liquidacion,
                        assigned_by_name: row.assigned_by_name,
                        observaciones: row.observaciones,
                        repartidor_shift_id: row.repartidor_shift_id,
                        items: row.venta_id ? (itemsByVenta[row.venta_id] || []) : [],
                        // 🆕 Información de devoluciones
                        returns: returns,
                        total_returned_quantity: totalReturnedQuantity,
                        total_returned_amount: totalReturnedAmount
                    };
                })
            });
        } catch (error) {
            console.error('[Repartidor Assignments] Error:', error);
            res.status(500).json({ success: false, message: 'Error al obtener asignaciones', error: error.message });
        }
    });

    // GET /api/repartidores/:employeeId/returns - Devoluciones de un repartidor
    router.get('/:employeeId/returns', authenticateToken, async (req, res) => {
        try {
            const { tenantId } = req.user;
            const { employeeId } = req.params;
            const { limit = 50, offset = 0 } = req.query;

            console.log(`[Repartidor Returns] Fetching - Employee: ${employeeId}`);

            const query = `
                SELECT
                    rr.id,
                    rr.assignment_id,
                    rr.quantity,
                    rr.amount,
                    rr.unit_price,
                    rr.return_date,
                    rr.source,
                    rr.notes,
                    rr.status,
                    rr.global_id,
                    CONCAT(e_registered.first_name, ' ', e_registered.last_name) as registered_by_name,
                    ra.assigned_quantity,
                    ra.assigned_amount,
                    ra.repartidor_shift_id,
                    v.ticket_number
                FROM repartidor_returns rr
                INNER JOIN repartidor_assignments ra ON rr.assignment_id = ra.id
                LEFT JOIN employees e_registered ON rr.registered_by_employee_id = e_registered.id
                LEFT JOIN ventas v ON ra.venta_id = v.id_venta
                WHERE rr.tenant_id = $1
                AND rr.employee_id = $2
                AND (rr.status IS NULL OR rr.status != 'deleted')
                ORDER BY rr.return_date DESC
                LIMIT $3 OFFSET $4
            `;

            const result = await pool.query(query, [tenantId, parseInt(employeeId), limit, offset]);

            console.log(`[Repartidor Returns] ✅ Found ${result.rows.length} returns`);

            res.json({
                success: true,
                data: result.rows.map(row => ({
                    id: row.id,
                    assignment_id: row.assignment_id,
                    ticket_number: row.ticket_number,
                    quantity: parseFloat(row.quantity),
                    amount: parseFloat(row.amount),
                    unit_price: parseFloat(row.unit_price),
                    return_date: row.return_date,
                    source: row.source,
                    notes: row.notes,
                    status: row.status || 'confirmed',
                    global_id: row.global_id,
                    registered_by_name: row.registered_by_name,
                    assigned_quantity: parseFloat(row.assigned_quantity),
                    assigned_amount: parseFloat(row.assigned_amount),
                    repartidor_shift_id: row.repartidor_shift_id
                }))
            });
        } catch (error) {
            console.error('[Repartidor Returns] Error:', error);
            res.status(500).json({ success: false, message: 'Error al obtener devoluciones', error: error.message });
        }
    });

    // ============================================================================
    // ENDPOINTS DE SNAPSHOT DE CORTE DE CAJA (CASH SNAPSHOT)
    // ============================================================================

    // GET /api/repartidores/shifts/:shiftId/cash-snapshot
    // Obtiene el snapshot de corte de caja para un turno de repartidor
    router.get('/shifts/:shiftId/cash-snapshot', authenticateToken, async (req, res) => {
        try {
            const { shiftId } = req.params;
            const { recalculate = 'false' } = req.query;
            const { tenantId, employeeId } = req.user;

            console.log(`[Cash Snapshot] GET - Shift: ${shiftId}, Recalculate: ${recalculate}, Tenant: ${tenantId}`);

            // Verificar que el turno pertenece al tenant del usuario
            const shiftCheck = await pool.query(
                `SELECT id, tenant_id, employee_id FROM shifts WHERE id = $1`,
                [shiftId]
            );

            if (shiftCheck.rows.length === 0) {
                return res.status(404).json({ success: false, message: 'Turno no encontrado' });
            }

            if (shiftCheck.rows[0].tenant_id !== tenantId) {
                return res.status(403).json({ success: false, message: 'No autorizado para este turno' });
            }

            // Verificar si existe el snapshot
            let snapshot = await pool.query(
                `SELECT * FROM shift_cash_snapshot WHERE shift_id = $1`,
                [shiftId]
            );

            // Si no existe o necesita recalcular, llamar a la función
            if (snapshot.rows.length === 0 || snapshot.rows[0].needs_recalculation || recalculate === 'true') {
                console.log(`[Cash Snapshot] Recalculando snapshot para shift ${shiftId}...`);

                try {
                    await pool.query('SELECT recalculate_shift_cash_snapshot($1)', [shiftId]);
                } catch (calcError) {
                    console.error(`[Cash Snapshot] Error al recalcular:`, calcError);
                    // Si la función falla, intentar crear un snapshot vacío
                    await pool.query(`
                        INSERT INTO shift_cash_snapshot (
                            tenant_id, branch_id, employee_id, shift_id, employee_role
                        )
                        SELECT s.tenant_id, s.branch_id, s.employee_id, s.id, r.name
                        FROM shifts s
                        INNER JOIN employees e ON s.employee_id = e.id
                        INNER JOIN roles r ON e.role_id = r.id
                        WHERE s.id = $1
                        ON CONFLICT (shift_id) DO NOTHING
                    `, [shiftId]);
                }

                // Volver a obtener el snapshot actualizado
                snapshot = await pool.query(
                    `SELECT * FROM shift_cash_snapshot WHERE shift_id = $1`,
                    [shiftId]
                );
            }

            if (snapshot.rows.length === 0) {
                return res.status(404).json({ success: false, message: 'No se pudo crear el snapshot' });
            }

            const data = snapshot.rows[0];

            res.json({
                success: true,
                data: {
                    id: data.id,
                    shift_id: data.shift_id,
                    tenant_id: data.tenant_id,
                    branch_id: data.branch_id,
                    employee_id: data.employee_id,

                    // Montos básicos
                    initial_amount: parseFloat(data.initial_amount),
                    cash_sales: parseFloat(data.cash_sales),
                    card_sales: parseFloat(data.card_sales),
                    credit_sales: parseFloat(data.credit_sales),
                    cash_payments: parseFloat(data.cash_payments),
                    card_payments: parseFloat(data.card_payments),
                    expenses: parseFloat(data.expenses),
                    deposits: parseFloat(data.deposits),
                    withdrawals: parseFloat(data.withdrawals),
                    expected_cash: parseFloat(data.expected_cash),

                    // Asignaciones y devoluciones
                    total_assigned_amount: parseFloat(data.total_assigned_amount),
                    total_assigned_quantity: parseFloat(data.total_assigned_quantity),
                    total_returned_amount: parseFloat(data.total_returned_amount),
                    total_returned_quantity: parseFloat(data.total_returned_quantity),
                    net_amount_to_deliver: parseFloat(data.net_amount_to_deliver),
                    net_quantity_delivered: parseFloat(data.net_quantity_delivered),

                    // Liquidación
                    actual_cash_delivered: parseFloat(data.actual_cash_delivered),
                    cash_difference: parseFloat(data.cash_difference),

                    // Contadores
                    assignment_count: data.assignment_count,
                    liquidated_assignment_count: data.liquidated_assignment_count,
                    return_count: data.return_count,
                    expense_count: data.expense_count,
                    deposit_count: data.deposit_count,
                    withdrawal_count: data.withdrawal_count,

                    // Metadata
                    last_updated_at: data.last_updated_at,
                    needs_recalculation: data.needs_recalculation,
                    needs_update: data.needs_update,
                    needs_deletion: data.needs_deletion,
                    synced_at: data.synced_at,
                    global_id: data.global_id
                }
            });

        } catch (error) {
            console.error('[Cash Snapshot] Error:', error);
            res.status(500).json({ success: false, message: 'Error al obtener snapshot de caja', error: error.message });
        }
    });

    // PUT /api/repartidores/shifts/:shiftId/cash-delivered
    // Actualiza el dinero entregado por el repartidor (cuando liquida)
    router.put('/shifts/:shiftId/cash-delivered', authenticateToken, async (req, res) => {
        try {
            const { shiftId } = req.params;
            const { actual_cash_delivered } = req.body;
            const { tenantId } = req.user;

            console.log(`[Cash Delivered] PUT - Shift: ${shiftId}, Amount: ${actual_cash_delivered}, Tenant: ${tenantId}`);

            if (actual_cash_delivered === undefined || actual_cash_delivered === null) {
                return res.status(400).json({ success: false, message: 'Debe proporcionar actual_cash_delivered' });
            }

            // Verificar que el turno pertenece al tenant
            const shiftCheck = await pool.query(
                `SELECT id, tenant_id FROM shifts WHERE id = $1`,
                [shiftId]
            );

            if (shiftCheck.rows.length === 0) {
                return res.status(404).json({ success: false, message: 'Turno no encontrado' });
            }

            if (shiftCheck.rows[0].tenant_id !== tenantId) {
                return res.status(403).json({ success: false, message: 'No autorizado para este turno' });
            }

            // Llamar a la función para actualizar el dinero entregado
            const result = await pool.query(
                'SELECT * FROM update_shift_cash_delivered($1, $2)',
                [shiftId, actual_cash_delivered]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({ success: false, message: 'No se encontró el snapshot para este turno' });
            }

            const data = result.rows[0];

            res.json({
                success: true,
                message: 'Dinero entregado actualizado correctamente',
                data: {
                    snapshot_id: data.snapshot_id,
                    net_amount_to_deliver: parseFloat(data.net_amount_to_deliver),
                    actual_cash_delivered: parseFloat(data.actual_cash_delivered),
                    cash_difference: parseFloat(data.cash_difference)
                }
            });

        } catch (error) {
            console.error('[Cash Delivered] Error:', error);
            res.status(500).json({ success: false, message: 'Error al actualizar dinero entregado', error: error.message });
        }
    });

    // POST /api/repartidores/shifts/:shiftId/recalculate-cash
    // Fuerza el recálculo del snapshot de caja
    router.post('/shifts/:shiftId/recalculate-cash', authenticateToken, async (req, res) => {
        try {
            const { shiftId } = req.params;
            const { tenantId } = req.user;

            console.log(`[Recalculate Cash] POST - Shift: ${shiftId}, Tenant: ${tenantId}`);

            // Verificar que el turno pertenece al tenant
            const shiftCheck = await pool.query(
                `SELECT id, tenant_id FROM shifts WHERE id = $1`,
                [shiftId]
            );

            if (shiftCheck.rows.length === 0) {
                return res.status(404).json({ success: false, message: 'Turno no encontrado' });
            }

            if (shiftCheck.rows[0].tenant_id !== tenantId) {
                return res.status(403).json({ success: false, message: 'No autorizado para este turno' });
            }

            // Forzar recálculo
            const result = await pool.query(
                'SELECT * FROM recalculate_shift_cash_snapshot($1)',
                [shiftId]
            );

            if (result.rows.length === 0) {
                return res.status(500).json({ success: false, message: 'Error al recalcular snapshot' });
            }

            const data = result.rows[0];

            res.json({
                success: true,
                message: 'Snapshot recalculado exitosamente',
                data: {
                    snapshot_id: data.snapshot_id,
                    expected_cash: parseFloat(data.expected_cash),
                    cash_sales: parseFloat(data.cash_sales),
                    total_assigned_amount: parseFloat(data.total_assigned_amount),
                    total_returned_amount: parseFloat(data.total_returned_amount),
                    net_amount_to_deliver: parseFloat(data.net_amount_to_deliver),
                    cash_difference: parseFloat(data.cash_difference),
                    needs_update: data.needs_update
                }
            });

        } catch (error) {
            console.error('[Recalculate Cash] Error:', error);
            res.status(500).json({ success: false, message: 'Error al recalcular snapshot', error: error.message });
        }
    });

    // GET /api/repartidores/cash-snapshots/pending-sync
    // Obtiene todos los snapshots que necesitan sincronización (para Desktop)
    router.get('/cash-snapshots/pending-sync', authenticateToken, async (req, res) => {
        try {
            const { tenantId, branchId } = req.user;
            const { all_branches = 'false' } = req.query;

            console.log(`[Pending Sync] GET - Tenant: ${tenantId}, Branch: ${branchId}, All Branches: ${all_branches}`);

            let query = `
                SELECT * FROM shift_cash_snapshot
                WHERE tenant_id = $1
                  AND (needs_update = true OR needs_deletion = true)
            `;

            const params = [tenantId];

            if (all_branches !== 'true') {
                query += ` AND branch_id = $2`;
                params.push(branchId);
            }

            query += ` ORDER BY last_updated_at DESC`;

            const result = await pool.query(query, params);

            res.json({
                success: true,
                count: result.rows.length,
                data: result.rows.map(row => ({
                    id: row.id,
                    shift_id: row.shift_id,
                    tenant_id: row.tenant_id,
                    branch_id: row.branch_id,
                    employee_id: row.employee_id,
                    expected_cash: parseFloat(row.expected_cash),
                    cash_sales: parseFloat(row.cash_sales),
                    total_assigned_amount: parseFloat(row.total_assigned_amount),
                    total_returned_amount: parseFloat(row.total_returned_amount),
                    net_amount_to_deliver: parseFloat(row.net_amount_to_deliver),
                    actual_cash_delivered: parseFloat(row.actual_cash_delivered),
                    cash_difference: parseFloat(row.cash_difference),
                    needs_update: row.needs_update,
                    needs_deletion: row.needs_deletion,
                    last_updated_at: row.last_updated_at,
                    global_id: row.global_id
                }))
            });

        } catch (error) {
            console.error('[Pending Sync] Error:', error);
            res.status(500).json({ success: false, message: 'Error al obtener snapshots pendientes', error: error.message });
        }
    });

    // PUT /api/repartidores/cash-snapshots/:snapshotId/mark-synced
    // Marca un snapshot como sincronizado (llamado por Desktop después de sincronizar)
    router.put('/cash-snapshots/:snapshotId/mark-synced', authenticateToken, async (req, res) => {
        try {
            const { snapshotId } = req.params;
            const { tenantId } = req.user;

            console.log(`[Mark Synced] PUT - Snapshot: ${snapshotId}, Tenant: ${tenantId}`);

            // Actualizar el snapshot
            const result = await pool.query(`
                UPDATE shift_cash_snapshot
                SET
                    needs_update = false,
                    synced_at = NOW()
                WHERE id = $1 AND tenant_id = $2
                RETURNING id, needs_update, synced_at
            `, [snapshotId, tenantId]);

            if (result.rows.length === 0) {
                return res.status(404).json({ success: false, message: 'Snapshot no encontrado' });
            }

            res.json({
                success: true,
                message: 'Snapshot marcado como sincronizado',
                data: result.rows[0]
            });

        } catch (error) {
            console.error('[Mark Synced] Error:', error);
            res.status(500).json({ success: false, message: 'Error al marcar snapshot como sincronizado', error: error.message });
        }
    });

    // ============================================================================
    // ENDPOINTS PARA REPARTIDOR RETURNS (Devoluciones con estados)
    // ============================================================================

    /**
     * POST /api/repartidores/returns
     * Crea o actualiza una devolución de repartidor
     * Soporta estados: draft, confirmed, deleted
     */
    router.post('/returns', authenticateToken, async (req, res) => {
        try {
            const {
                global_id,
                assignment_id,
                assignment_global_id,  // ✅ Aceptar GlobalId del assignment
                employee_id,
                registered_by_employee_id,
                tenant_id,
                branch_id,
                shift_id,
                quantity,
                unit_price,
                amount,
                return_date,
                source = 'desktop',
                status = 'draft',
                notes,
                terminal_id,
                local_op_seq,
                created_local_utc,
                device_event_raw,
                needs_update = false
            } = req.body;

            console.log(`[RepartidorReturns] ${needs_update ? 'UPDATE' : 'INSERT'} - GlobalId: ${global_id}, Status: ${status}, Quantity: ${quantity}`);

            // Validar campos requeridos
            if (!global_id || (!assignment_id && !assignment_global_id) || !employee_id || !quantity) {
                return res.status(400).json({
                    success: false,
                    message: 'Campos requeridos: global_id, (assignment_id o assignment_global_id), employee_id, quantity'
                });
            }

            // Si se envió assignment_global_id, resolver el ID numérico
            let finalAssignmentId = assignment_id;
            if (!finalAssignmentId && assignment_global_id) {
                const assignmentResult = await pool.query(
                    'SELECT id FROM repartidor_assignments WHERE global_id = $1',
                    [assignment_global_id]
                );

                if (assignmentResult.rows.length === 0) {
                    return res.status(404).json({
                        success: false,
                        message: `RepartidorAssignment con global_id ${assignment_global_id} no encontrado`
                    });
                }

                finalAssignmentId = assignmentResult.rows[0].id;
                console.log(`[RepartidorReturns] ✅ Assignment resuelto: ${assignment_global_id} → ID ${finalAssignmentId}`);
            }

            // Verificar si ya existe (idempotencia)
            const existing = await pool.query(
                'SELECT * FROM repartidor_returns WHERE global_id = $1',
                [global_id]
            );

            if (existing.rows.length > 0) {
                // Ya existe, verificar si es UPDATE
                if (needs_update) {
                    console.log(`[RepartidorReturns] Actualizando registro existente: ${global_id}`);

                    const result = await pool.query(`
                        UPDATE repartidor_returns
                        SET
                            quantity = $1,
                            amount = $2,
                            status = $3,
                            notes = $4,
                            updated_at = NOW()
                        WHERE global_id = $5
                        RETURNING *
                    `, [quantity, amount, status, notes, global_id]);

                    console.log(`[RepartidorReturns] ✅ Return actualizado: ${global_id} (status: ${status})`);

                    return res.json({
                        success: true,
                        data: result.rows[0],
                        message: 'Devolución actualizada correctamente'
                    });
                }

                // Ya existe y no requiere update = idempotente
                console.log(`[RepartidorReturns] Registro ya existe (idempotente): ${global_id}`);
                return res.json({
                    success: true,
                    data: existing.rows[0],
                    message: 'Devolución ya registrada (idempotente)'
                });
            }

            // No existe, INSERT nuevo
            console.log(`[RepartidorReturns] Insertando nuevo registro: ${global_id}`);

            const result = await pool.query(`
                INSERT INTO repartidor_returns (
                    global_id, assignment_id, employee_id,
                    registered_by_employee_id, tenant_id, branch_id,
                    shift_id, quantity, unit_price, amount,
                    return_date, source, status, notes,
                    terminal_id, local_op_seq, created_local_utc, device_event_raw
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
                RETURNING *
            `, [
                global_id,
                finalAssignmentId,  // ✅ Usar el ID resuelto
                employee_id,
                registered_by_employee_id || employee_id,
                tenant_id,
                branch_id,
                shift_id,
                quantity,
                unit_price,
                amount,
                return_date || new Date(),
                source,
                status,
                notes,
                terminal_id,
                local_op_seq,
                created_local_utc,
                device_event_raw
            ]);

            console.log(`[RepartidorReturns] ✅ Return creado: ${global_id} (status: ${status})`);

            res.json({
                success: true,
                data: result.rows[0],
                message: status === 'draft'
                    ? 'Devolución borrador guardada'
                    : 'Devolución confirmada'
            });

        } catch (error) {
            console.error('[RepartidorReturns] Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al procesar devolución',
                error: error.message
            });
        }
    });

    /**
     * GET /api/repartidores/returns/by-employee/:employeeId
     * Obtiene todas las devoluciones de un repartidor (incluye borradores)
     * Query params:
     *   - tenant_id: required
     *   - include_deleted: 'true' para incluir eliminados
     *   - status_filter: 'draft', 'confirmed', 'deleted' (opcional)
     */
    router.get('/returns/by-employee/:employeeId', authenticateToken, async (req, res) => {
        try {
            const { employeeId } = req.params;
            const { tenant_id, include_deleted = 'false', status_filter } = req.query;

            if (!tenant_id) {
                return res.status(400).json({
                    success: false,
                    message: 'tenant_id es requerido'
                });
            }

            console.log(`[RepartidorReturns] GET by employee: ${employeeId}, tenant: ${tenant_id}, include_deleted: ${include_deleted}, status: ${status_filter || 'ALL'}`);

            let query = `
                SELECT
                    r.*,
                    a.assigned_quantity,
                    a.assigned_amount,
                    a.status as assignment_status,
                    a.fecha_asignacion,
                    v.ticket_number,
                    CONCAT(e.first_name, ' ', e.last_name) as registered_by_name
                FROM repartidor_returns r
                JOIN repartidor_assignments a ON r.assignment_id = a.id
                JOIN ventas v ON a.venta_id = v.id_venta
                LEFT JOIN employees e ON r.registered_by_employee_id = e.id
                WHERE r.employee_id = $1
                AND r.tenant_id = $2
            `;

            const params = [employeeId, tenant_id];
            let paramIndex = 3;

            // Filtrar eliminados si no se piden explícitamente
            if (include_deleted !== 'true') {
                query += ` AND r.status != 'deleted'`;
            }

            // Filtrar por status específico
            if (status_filter) {
                query += ` AND r.status = $${paramIndex}`;
                params.push(status_filter);
                paramIndex++;
            }

            query += ` ORDER BY r.return_date DESC`;

            const result = await pool.query(query, params);

            console.log(`[RepartidorReturns] ✅ Encontradas ${result.rows.length} devoluciones`);

            res.json({
                success: true,
                data: result.rows,
                count: result.rows.length
            });

        } catch (error) {
            console.error('[RepartidorReturns] Error obteniendo devoluciones:', error);
            res.status(500).json({
                success: false,
                message: 'Error al obtener devoluciones',
                error: error.message
            });
        }
    });

    /**
     * DELETE /api/repartidores/returns/:globalId
     * Elimina (soft delete) una devolución borrador
     * Solo se pueden eliminar borradores (status = 'draft')
     */
    router.delete('/returns/:globalId', authenticateToken, async (req, res) => {
        try {
            const { globalId } = req.params;

            console.log(`[RepartidorReturns] DELETE (soft): ${globalId}`);

            // Verificar que existe y es borrador
            const existing = await pool.query(
                'SELECT * FROM repartidor_returns WHERE global_id = $1',
                [globalId]
            );

            if (existing.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Devolución no encontrada'
                });
            }

            if (existing.rows[0].status !== 'draft') {
                return res.status(400).json({
                    success: false,
                    message: 'Solo se pueden eliminar borradores'
                });
            }

            // Soft delete
            const result = await pool.query(`
                UPDATE repartidor_returns
                SET status = 'deleted', updated_at = NOW()
                WHERE global_id = $1
                RETURNING *
            `, [globalId]);

            console.log(`[RepartidorReturns] ✅ Devolución eliminada (soft): ${globalId}`);

            res.json({
                success: true,
                data: result.rows[0],
                message: 'Devolución eliminada correctamente'
            });

        } catch (error) {
            console.error('[RepartidorReturns] Error eliminando:', error);
            res.status(500).json({
                success: false,
                message: 'Error al eliminar devolución',
                error: error.message
            });
        }
    });

    return router;
};
