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
    // DEPRECATED: Los cálculos se hacen con queries, no con snapshots
    router.get('/shifts/:shiftId/cash-snapshot', authenticateToken, async (req, res) => {
        return res.status(501).json({
            success: false,
            message: 'Endpoint deprecated - Los cálculos se hacen con queries dinámicas, no con snapshots'
        });
        /* CODIGO ORIGINAL COMENTADO

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
        */ // FIN CODIGO COMENTADO
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
    // DEPRECATED: Los cálculos se hacen con queries, no con snapshots
    router.get('/cash-snapshots/pending-sync', authenticateToken, async (req, res) => {
        return res.status(501).json({
            success: false,
            message: 'Endpoint deprecated - Los cálculos se hacen con queries dinámicas, no con snapshots'
        });
        /* CODIGO ORIGINAL COMENTADO
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
        */ // FIN CODIGO COMENTADO
    });

    // PUT /api/repartidores/cash-snapshots/:snapshotId/mark-synced
    // DEPRECATED: Los cálculos se hacen con queries, no con snapshots
    router.put('/cash-snapshots/:snapshotId/mark-synced', authenticateToken, async (req, res) => {
        return res.status(501).json({
            success: false,
            message: 'Endpoint deprecated - Los cálculos se hacen con queries dinámicas, no con snapshots'
        });
        /* CODIGO ORIGINAL COMENTADO
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
        */ // FIN CODIGO COMENTADO
    });

    // ============================================================================
    // ENDPOINTS PARA REPARTIDOR RETURNS (Devoluciones con estados)
    // ============================================================================

    /**
     * POST /api/repartidores/returns
     * Crea o actualiza una devolución de repartidor
     * Soporta estados: draft, confirmed, deleted
     * SIN autenticación - sincronización offline-first idempotente
     */
    router.post('/returns', async (req, res) => {
        try {
            const {
                global_id,
                assignment_id,
                assignment_global_id,  // ✅ Aceptar GlobalId del assignment
                employee_id,
                employee_global_id,    // ✅ Aceptar GlobalId del empleado
                registered_by_employee_id,
                registered_by_employee_global_id, // ✅ Aceptar GlobalId del registrador
                shift_global_id,       // ✅ Aceptar GlobalId del turno
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

            // Validar campos requeridos (aceptar IDs numéricos O GlobalIds)
            if (!global_id || (!assignment_id && !assignment_global_id) || (!employee_id && !employee_global_id) || !quantity) {
                return res.status(400).json({
                    success: false,
                    message: 'Campos requeridos: global_id, (assignment_id o assignment_global_id), (employee_id o employee_global_id), quantity'
                });
            }

            // ✅ RESOLVER GLOBALIDS → IDs numéricos

            // Assignment
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

            // Employee (repartidor)
            let finalEmployeeId = employee_id;
            if (!finalEmployeeId && employee_global_id) {
                const empResult = await pool.query(
                    'SELECT id FROM employees WHERE global_id = $1',
                    [employee_global_id]
                );
                if (empResult.rows.length === 0) {
                    return res.status(404).json({
                        success: false,
                        message: `Employee con global_id ${employee_global_id} no encontrado`
                    });
                }
                finalEmployeeId = empResult.rows[0].id;
            }

            // Registered by employee
            let finalRegisteredById = registered_by_employee_id;
            if (!finalRegisteredById && registered_by_employee_global_id) {
                const regResult = await pool.query(
                    'SELECT id FROM employees WHERE global_id = $1',
                    [registered_by_employee_global_id]
                );
                if (regResult.rows.length > 0) {
                    finalRegisteredById = regResult.rows[0].id;
                }
            }

            // Shift
            let finalShiftId = shift_id;
            if (!finalShiftId && shift_global_id) {
                const shiftResult = await pool.query(
                    'SELECT id FROM shifts WHERE global_id = $1',
                    [shift_global_id]
                );
                if (shiftResult.rows.length > 0) {
                    finalShiftId = shiftResult.rows[0].id;
                }
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
                finalAssignmentId,       // ✅ Usar el ID resuelto
                finalEmployeeId,         // ✅ Usar el ID resuelto
                finalRegisteredById || finalEmployeeId, // ✅ Usar el ID resuelto
                tenant_id,
                branch_id,
                finalShiftId,            // ✅ Usar el ID resuelto
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

    // ============================================================================
    // GET /api/repartidores/:employeeId/shifts-summary
    // Obtiene resumen de turnos de caja de un repartidor con estadísticas
    // ============================================================================
    router.get('/:employeeId/shifts-summary', authenticateToken, async (req, res) => {
        try {
            const { tenantId, branchId: userBranchId } = req.user;
            const { employeeId } = req.params;
            const { limit = 20, offset = 0, status = 'all' } = req.query;

            console.log(`[Repartidor Shifts] GET - Employee: ${employeeId}, Tenant: ${tenantId}, Status: ${status}`);

            // Query para obtener turnos con resumen de asignaciones y devoluciones
            let query = `
                WITH shift_assignments AS (
                    SELECT
                        ra.repartidor_shift_id,
                        SUM(ra.assigned_quantity) as total_assigned_kg,
                        SUM(ra.assigned_amount) as total_assigned_amount,
                        COUNT(*) as assignment_count,
                        COUNT(CASE WHEN ra.status = 'liquidated' THEN 1 END) as liquidated_count
                    FROM repartidor_assignments ra
                    WHERE ra.employee_id = $1 AND ra.tenant_id = $2
                    GROUP BY ra.repartidor_shift_id
                ),
                shift_returns AS (
                    SELECT
                        ra.repartidor_shift_id,
                        SUM(rr.quantity) as total_returned_kg,
                        SUM(rr.amount) as total_returned_amount,
                        COUNT(rr.id) as return_count
                    FROM repartidor_returns rr
                    INNER JOIN repartidor_assignments ra ON rr.assignment_id = ra.id
                    WHERE rr.employee_id = $1 AND rr.tenant_id = $2
                      AND (rr.status IS NULL OR rr.status != 'deleted')
                    GROUP BY ra.repartidor_shift_id
                ),
                shift_expenses AS (
                    SELECT
                        e.shift_id,
                        SUM(e.amount) as total_expenses,
                        COUNT(*) as expense_count
                    FROM expenses e
                    WHERE e.employee_id = $1 AND e.tenant_id = $2
                    GROUP BY e.shift_id
                )
                SELECT
                    s.id as shift_id,
                    s.start_time,
                    s.end_time,
                    s.is_cash_cut_open,
                    s.initial_amount,
                    CONCAT(e.first_name, ' ', e.last_name) as employee_name,
                    b.name as branch_name,
                    COALESCE(sa.total_assigned_kg, 0) as total_assigned_kg,
                    COALESCE(sa.total_assigned_amount, 0) as total_assigned_amount,
                    COALESCE(sa.assignment_count, 0) as assignment_count,
                    COALESCE(sa.liquidated_count, 0) as liquidated_count,
                    COALESCE(sr.total_returned_kg, 0) as total_returned_kg,
                    COALESCE(sr.total_returned_amount, 0) as total_returned_amount,
                    COALESCE(sr.return_count, 0) as return_count,
                    COALESCE(se.total_expenses, 0) as total_expenses,
                    COALESCE(se.expense_count, 0) as expense_count,
                    -- Neto a entregar
                    (COALESCE(sa.total_assigned_amount, 0) - COALESCE(sr.total_returned_amount, 0) - COALESCE(se.total_expenses, 0)) as net_to_deliver,
                    (COALESCE(sa.total_assigned_kg, 0) - COALESCE(sr.total_returned_kg, 0)) as net_delivered_kg
                FROM shifts s
                LEFT JOIN employees e ON s.employee_id = e.id
                LEFT JOIN branches b ON s.branch_id = b.id
                LEFT JOIN shift_assignments sa ON s.id = sa.repartidor_shift_id
                LEFT JOIN shift_returns sr ON s.id = sr.repartidor_shift_id
                LEFT JOIN shift_expenses se ON s.id = se.shift_id
                WHERE s.employee_id = $1 AND s.tenant_id = $2
            `;

            const params = [parseInt(employeeId), tenantId];
            let paramIndex = 3;

            // Filtrar por estado del turno
            if (status === 'open') {
                query += ` AND s.is_cash_cut_open = true`;
            } else if (status === 'closed') {
                query += ` AND s.is_cash_cut_open = false`;
            }

            query += ` ORDER BY s.start_time DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
            params.push(parseInt(limit), parseInt(offset));

            const result = await pool.query(query, params);

            console.log(`[Repartidor Shifts] ✅ Found ${result.rows.length} shifts`);

            res.json({
                success: true,
                data: result.rows.map(row => ({
                    shift_id: row.shift_id,
                    start_time: row.start_time,
                    end_time: row.end_time,
                    is_open: row.is_cash_cut_open,
                    initial_amount: parseFloat(row.initial_amount || 0),
                    employee_name: row.employee_name,
                    branch_name: row.branch_name,
                    // Asignaciones
                    total_assigned_kg: parseFloat(row.total_assigned_kg),
                    total_assigned_amount: parseFloat(row.total_assigned_amount),
                    assignment_count: parseInt(row.assignment_count),
                    liquidated_count: parseInt(row.liquidated_count),
                    // Devoluciones
                    total_returned_kg: parseFloat(row.total_returned_kg),
                    total_returned_amount: parseFloat(row.total_returned_amount),
                    return_count: parseInt(row.return_count),
                    // Gastos
                    total_expenses: parseFloat(row.total_expenses),
                    expense_count: parseInt(row.expense_count),
                    // Netos
                    net_to_deliver: parseFloat(row.net_to_deliver),
                    net_delivered_kg: parseFloat(row.net_delivered_kg)
                })),
                count: result.rows.length
            });

        } catch (error) {
            console.error('[Repartidor Shifts] Error:', error);
            res.status(500).json({ success: false, message: 'Error al obtener turnos', error: error.message });
        }
    });

    // ============================================================================
    // POST /api/repartidores/:employeeId/register-shortage
    // Registra un faltante de repartidor en employee_debts
    // ============================================================================
    router.post('/:employeeId/register-shortage', authenticateToken, async (req, res) => {
        try {
            const { tenantId, branchId, employeeId: registeredByEmployeeId } = req.user;
            const { employeeId } = req.params;
            const {
                shift_id,
                monto_deuda,
                notas,
                fecha_deuda
            } = req.body;

            console.log(`[Repartidor Shortage] POST - Employee: ${employeeId}, Amount: ${monto_deuda}, Shift: ${shift_id}`);

            if (!monto_deuda || monto_deuda <= 0) {
                return res.status(400).json({ success: false, message: 'monto_deuda es requerido y debe ser mayor a 0' });
            }

            // Generar global_id único para idempotencia
            const globalId = `shortage_${tenantId}_${employeeId}_${shift_id || 'manual'}_${Date.now()}`;

            const result = await pool.query(`
                INSERT INTO employee_debts (
                    tenant_id, branch_id, employee_id, shift_id,
                    monto_deuda, monto_pagado, estado, fecha_deuda, notas,
                    global_id
                ) VALUES ($1, $2, $3, $4, $5, 0, 'pendiente', $6, $7, $8)
                RETURNING *
            `, [
                tenantId,
                branchId,
                parseInt(employeeId),
                shift_id || null,
                parseFloat(monto_deuda),
                fecha_deuda || new Date(),
                notas || `Faltante registrado desde app móvil`,
                globalId
            ]);

            console.log(`[Repartidor Shortage] ✅ Shortage registered: $${monto_deuda} for employee ${employeeId}`);

            res.json({
                success: true,
                data: result.rows[0],
                message: 'Faltante registrado correctamente'
            });

        } catch (error) {
            console.error('[Repartidor Shortage] Error:', error);
            res.status(500).json({ success: false, message: 'Error al registrar faltante', error: error.message });
        }
    });

    // ============================================================================
    // GET /api/repartidores/:employeeId/debts
    // Obtiene las deudas/faltantes de un repartidor
    // ============================================================================
    router.get('/:employeeId/debts', authenticateToken, async (req, res) => {
        try {
            const { tenantId } = req.user;
            const { employeeId } = req.params;
            const { estado = 'pendiente', limit = 50, offset = 0 } = req.query;

            console.log(`[Repartidor Debts] GET - Employee: ${employeeId}, Estado: ${estado}`);

            let query = `
                SELECT
                    ed.id,
                    ed.global_id,
                    ed.employee_id,
                    CONCAT(e.first_name, ' ', e.last_name) as employee_name,
                    ed.branch_id,
                    b.name as branch_name,
                    ed.shift_id,
                    ed.monto_deuda,
                    ed.monto_pagado,
                    (ed.monto_deuda - COALESCE(ed.monto_pagado, 0)) as monto_pendiente,
                    ed.estado,
                    ed.fecha_deuda,
                    ed.fecha_pago,
                    ed.notas,
                    ed.created_at
                FROM employee_debts ed
                LEFT JOIN employees e ON e.id = ed.employee_id
                LEFT JOIN branches b ON b.id = ed.branch_id
                WHERE ed.employee_id = $1 AND ed.tenant_id = $2
            `;

            const params = [parseInt(employeeId), tenantId];
            let paramIndex = 3;

            if (estado && estado !== 'all') {
                query += ` AND ed.estado = $${paramIndex}`;
                params.push(estado);
                paramIndex++;
            }

            query += ` ORDER BY ed.fecha_deuda DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
            params.push(parseInt(limit), parseInt(offset));

            const result = await pool.query(query, params);

            // Calcular total pendiente
            const totalQuery = await pool.query(`
                SELECT
                    SUM(monto_deuda) as total_deuda,
                    SUM(monto_pagado) as total_pagado,
                    SUM(monto_deuda - COALESCE(monto_pagado, 0)) as total_pendiente,
                    COUNT(*) as count
                FROM employee_debts
                WHERE employee_id = $1 AND tenant_id = $2 AND estado = 'pendiente'
            `, [parseInt(employeeId), tenantId]);

            const totals = totalQuery.rows[0];

            console.log(`[Repartidor Debts] ✅ Found ${result.rows.length} debts, Total pendiente: $${totals.total_pendiente || 0}`);

            res.json({
                success: true,
                data: result.rows.map(row => ({
                    id: row.id,
                    global_id: row.global_id,
                    employee_id: row.employee_id,
                    employee_name: row.employee_name,
                    branch_id: row.branch_id,
                    branch_name: row.branch_name,
                    shift_id: row.shift_id,
                    monto_deuda: parseFloat(row.monto_deuda),
                    monto_pagado: parseFloat(row.monto_pagado || 0),
                    monto_pendiente: parseFloat(row.monto_pendiente),
                    estado: row.estado,
                    fecha_deuda: row.fecha_deuda,
                    fecha_pago: row.fecha_pago,
                    notas: row.notas,
                    created_at: row.created_at
                })),
                summary: {
                    total_deuda: parseFloat(totals.total_deuda || 0),
                    total_pagado: parseFloat(totals.total_pagado || 0),
                    total_pendiente: parseFloat(totals.total_pendiente || 0),
                    count: parseInt(totals.count || 0)
                },
                count: result.rows.length
            });

        } catch (error) {
            console.error('[Repartidor Debts] Error:', error);
            res.status(500).json({ success: false, message: 'Error al obtener deudas', error: error.message });
        }
    });

    return router;
};
