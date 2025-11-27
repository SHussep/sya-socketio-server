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

            res.json({
                success: true,
                data: result.rows.map(row => ({
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
                    observaciones: row.observaciones
                }))
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
                    CONCAT(e_registered.first_name, ' ', e_registered.last_name) as registered_by_name,
                    ra.assigned_quantity,
                    ra.assigned_amount,
                    v.ticket_number
                FROM repartidor_returns rr
                INNER JOIN repartidor_assignments ra ON rr.assignment_id = ra.id
                LEFT JOIN employees e_registered ON rr.registered_by_employee_id = e_registered.id
                LEFT JOIN ventas v ON ra.venta_id = v.id_venta
                WHERE rr.tenant_id = $1 AND rr.employee_id = $2
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
                    registered_by_name: row.registered_by_name,
                    assigned_quantity: parseFloat(row.assigned_quantity),
                    assigned_amount: parseFloat(row.assigned_amount)
                }))
            });
        } catch (error) {
            console.error('[Repartidor Returns] Error:', error);
            res.status(500).json({ success: false, message: 'Error al obtener devoluciones', error: error.message });
        }
    });

    return router;
};
