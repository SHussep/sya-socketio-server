// routes/repartidores.js
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');

// ⚠️ SEGURIDAD: JWT_SECRET debe estar configurado en el entorno
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
    console.error('[SECURITY] ❌ JWT_SECRET no está configurado en el entorno');
}

// Middleware para validar JWT token
function authenticateToken(req, res, next) {
    if (!JWT_SECRET) {
        return res.status(500).json({ success: false, message: 'Configuración de seguridad faltante' });
    }

    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ success: false, message: 'Token no proporcionado' });
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
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
            const { all_branches = 'false', branch_id, shift_id, only_open_shifts = 'false', start_date, end_date } = req.query;

            // Prioridad: 1. branch_id del query, 2. branchId del JWT
            const targetBranchId = branch_id ? parseInt(branch_id) : userBranchId;

            console.log(`[Repartidores Summary] Fetching - Tenant: ${tenantId}, Branch: ${targetBranchId}, Shift: ${shift_id || 'ALL'}, all_branches: ${all_branches}, Only Open Shifts: ${only_open_shifts}, DateRange: ${start_date || 'ALL'} to ${end_date || 'ALL'}`);

            let query = `
                WITH assignment_stats AS (
                    SELECT
                        ra.employee_id,
                        e.global_id as employee_global_id,
                        CONCAT(e.first_name, ' ', e.last_name) as repartidor_name,
                        e.role_id,
                        r.name as role_name,
                        e.main_branch_id as branch_id,
                        b.name as branch_name,

                        -- Asignaciones pendientes
                        SUM(CASE WHEN ra.status = 'pending' THEN ra.assigned_quantity ELSE 0 END) as pending_quantity,
                        SUM(CASE WHEN ra.status = 'pending' THEN ra.assigned_amount ELSE 0 END) as pending_amount,

                        -- Asignaciones en progreso
                        SUM(CASE WHEN ra.status = 'in_progress' THEN ra.assigned_quantity ELSE 0 END) as in_progress_quantity,
                        SUM(CASE WHEN ra.status = 'in_progress' THEN ra.assigned_amount ELSE 0 END) as in_progress_amount,

                        -- Asignaciones liquidadas
                        SUM(CASE WHEN ra.status = 'liquidated' THEN ra.assigned_quantity ELSE 0 END) as liquidated_quantity,
                        SUM(CASE WHEN ra.status = 'liquidated' THEN ra.assigned_amount ELSE 0 END) as liquidated_amount,

                        -- Totales de ITEMS (productos) - cada fila en repartidor_assignments
                        COUNT(*) as total_items,
                        COUNT(CASE WHEN ra.status = 'pending' THEN 1 END) as pending_item_count,
                        COUNT(CASE WHEN ra.status = 'in_progress' THEN 1 END) as in_progress_item_count,
                        COUNT(CASE WHEN ra.status = 'liquidated' THEN 1 END) as liquidated_item_count,
                        COUNT(CASE WHEN ra.status = 'cancelled' THEN 1 END) as cancelled_item_count,

                        -- Totales de ASIGNACIONES ÚNICAS (por venta_id) - una asignación puede tener múltiples productos
                        COUNT(DISTINCT CASE WHEN ra.status IN ('pending', 'in_progress', 'liquidated', 'cancelled') THEN COALESCE(ra.venta_id, ra.id) END) as total_assignments,
                        COUNT(DISTINCT CASE WHEN ra.status = 'pending' THEN COALESCE(ra.venta_id, ra.id) END) as pending_count,
                        COUNT(DISTINCT CASE WHEN ra.status = 'in_progress' THEN COALESCE(ra.venta_id, ra.id) END) as in_progress_count,
                        COUNT(DISTINCT CASE WHEN ra.status = 'liquidated' THEN COALESCE(ra.venta_id, ra.id) END) as liquidated_count,
                        COUNT(DISTINCT CASE WHEN ra.status = 'cancelled' THEN COALESCE(ra.venta_id, ra.id) END) as cancelled_count,

                        MAX(ra.fecha_asignacion) as last_assignment_date
                    FROM repartidor_assignments ra
                    LEFT JOIN employees e ON ra.employee_id = e.id
                    LEFT JOIN roles r ON e.role_id = r.id
                    LEFT JOIN branches b ON e.main_branch_id = b.id
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

            // ✅ Filtrar por rango de fechas (fecha_asignacion)
            if (start_date) {
                query += ` AND DATE(ra.fecha_asignacion) >= $${paramIndex}`;
                params.push(start_date);
                paramIndex++;
            }
            if (end_date) {
                query += ` AND DATE(ra.fecha_asignacion) <= $${paramIndex}`;
                params.push(end_date);
                paramIndex++;
            }

            query += `
                    GROUP BY ra.employee_id, e.global_id, e.first_name, e.last_name, e.role_id, r.name, e.main_branch_id, b.name
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

            // Repetir filtros para returns (usando los mismos índices de params)
            let returnsParamIndex = 2;
            if (all_branches !== 'true' && targetBranchId) {
                query += ` AND rr.branch_id = $${returnsParamIndex}`;
                returnsParamIndex++;
            }
            if (shift_id) {
                query += ` AND rr.shift_id = $${returnsParamIndex}`;
                returnsParamIndex++;
            }
            // ✅ Filtrar devoluciones por fecha de asignación
            if (start_date) {
                query += ` AND DATE(ra.fecha_asignacion) >= $${returnsParamIndex}`;
                returnsParamIndex++;
            }
            if (end_date) {
                query += ` AND DATE(ra.fecha_asignacion) <= $${returnsParamIndex}`;
                returnsParamIndex++;
            }

            query += `
                    GROUP BY ra.employee_id
                ),
                -- Agrupar totales por unidad de medida (para mostrar "200 kg, 100 pz" en vez de "300 kg")
                quantity_by_unit AS (
                    SELECT
                        ra.employee_id,
                        COALESCE(ra.unit_abbreviation, 'kg') as unit,
                        SUM(CASE WHEN ra.status IN ('pending', 'in_progress') THEN ra.assigned_quantity ELSE 0 END) as active_qty,
                        SUM(CASE WHEN ra.status IN ('pending', 'in_progress') THEN ra.assigned_amount ELSE 0 END) as active_amt
                    FROM repartidor_assignments ra
                    LEFT JOIN shifts s ON ra.repartidor_shift_id = s.id
                    WHERE ra.tenant_id = $1
                      AND ra.status IN ('pending', 'in_progress')
            `;

            // Repetir filtros para quantity_by_unit (usando los mismos índices de params)
            let qbuParamIndex = 2;
            if (only_open_shifts === 'true') {
                query += ` AND (s.id IS NULL OR s.is_cash_cut_open = true)`;
            }
            if (all_branches !== 'true' && targetBranchId) {
                query += ` AND ra.branch_id = $${qbuParamIndex}`;
                qbuParamIndex++;
            }
            if (shift_id) {
                qbuParamIndex++; // skip shift_id param index
            }
            // ✅ Filtrar por fecha de asignación
            if (start_date) {
                query += ` AND DATE(ra.fecha_asignacion) >= $${qbuParamIndex}`;
                qbuParamIndex++;
            }
            if (end_date) {
                query += ` AND DATE(ra.fecha_asignacion) <= $${qbuParamIndex}`;
                qbuParamIndex++;
            }

            query += `
                    GROUP BY ra.employee_id, COALESCE(ra.unit_abbreviation, 'kg')
                ),
                quantity_by_unit_agg AS (
                    SELECT
                        employee_id,
                        json_agg(json_build_object('unit', unit, 'quantity', active_qty, 'amount', active_amt) ORDER BY active_qty DESC) as quantities_by_unit
                    FROM quantity_by_unit
                    WHERE active_qty > 0
                    GROUP BY employee_id
                ),
                -- Turno abierto actual de cada empleado (para poder crear asignaciones desde móvil)
                current_open_shifts AS (
                    SELECT DISTINCT ON (s.employee_id)
                        s.employee_id,
                        e.global_id as employee_global_id,
                        CONCAT(e.first_name, ' ', e.last_name) as repartidor_name,
                        e.role_id,
                        r.name as role_name,
                        e.main_branch_id as branch_id,
                        b.name as branch_name,
                        s.global_id as current_shift_global_id
                    FROM shifts s
                    LEFT JOIN employees e ON s.employee_id = e.id
                    LEFT JOIN roles r ON e.role_id = r.id
                    LEFT JOIN branches b ON e.main_branch_id = b.id
                    WHERE s.tenant_id = $1
                      AND s.is_cash_cut_open = true
                    ORDER BY s.employee_id, s.start_time DESC
                )
                -- Query principal: UNION de empleados con turno abierto y empleados con asignaciones
                SELECT
                    COALESCE(a.employee_id, cos.employee_id) as employee_id,
                    COALESCE(a.employee_global_id, cos.employee_global_id) as employee_global_id,
                    COALESCE(a.repartidor_name, cos.repartidor_name) as repartidor_name,
                    COALESCE(a.role_id, cos.role_id) as role_id,
                    COALESCE(a.role_name, cos.role_name) as role_name,
                    COALESCE(a.branch_id, cos.branch_id) as branch_id,
                    COALESCE(a.branch_name, cos.branch_name, 'Sin sucursal') as branch_name,
                    COALESCE(a.pending_quantity, 0) as pending_quantity,
                    COALESCE(a.pending_amount, 0) as pending_amount,
                    COALESCE(a.in_progress_quantity, 0) as in_progress_quantity,
                    COALESCE(a.in_progress_amount, 0) as in_progress_amount,
                    COALESCE(a.liquidated_quantity, 0) as liquidated_quantity,
                    COALESCE(a.liquidated_amount, 0) as liquidated_amount,
                    COALESCE(a.total_items, 0) as total_items,
                    COALESCE(a.pending_item_count, 0) as pending_item_count,
                    COALESCE(a.in_progress_item_count, 0) as in_progress_item_count,
                    COALESCE(a.liquidated_item_count, 0) as liquidated_item_count,
                    COALESCE(a.cancelled_item_count, 0) as cancelled_item_count,
                    COALESCE(a.total_assignments, 0) as total_assignments,
                    COALESCE(a.pending_count, 0) as pending_count,
                    COALESCE(a.in_progress_count, 0) as in_progress_count,
                    COALESCE(a.liquidated_count, 0) as liquidated_count,
                    COALESCE(a.cancelled_count, 0) as cancelled_count,
                    a.last_assignment_date,
                    COALESCE(rs.total_returned_quantity, 0) as total_returned_quantity,
                    COALESCE(rs.total_returned_amount, 0) as total_returned_amount,
                    COALESCE(rs.return_count, 0) as return_count,
                    COALESCE(a.pending_quantity, 0) + COALESCE(a.in_progress_quantity, 0) as active_quantity,
                    COALESCE(a.pending_amount, 0) + COALESCE(a.in_progress_amount, 0) as active_amount,
                    COALESCE(qbu.quantities_by_unit, '[]'::json) as quantities_by_unit,
                    cos.current_shift_global_id
                FROM current_open_shifts cos
                LEFT JOIN assignment_stats a ON cos.employee_id = a.employee_id
                LEFT JOIN returns_stats rs ON cos.employee_id = rs.employee_id
                LEFT JOIN quantity_by_unit_agg qbu ON cos.employee_id = qbu.employee_id
            `;

            // Si only_open_shifts=true, ya estamos partiendo de current_open_shifts (turno abierto)
            // Si only_open_shifts=false, necesitamos UNION con assignment_stats para ver histórico
            if (only_open_shifts !== 'true') {
                // Agregar empleados con asignaciones aunque no tengan turno abierto (histórico)
                query += `
                UNION
                SELECT
                    a.employee_id,
                    a.employee_global_id,
                    a.repartidor_name,
                    a.role_id,
                    a.role_name,
                    a.branch_id,
                    COALESCE(a.branch_name, 'Sin sucursal') as branch_name,
                    a.pending_quantity,
                    a.pending_amount,
                    a.in_progress_quantity,
                    a.in_progress_amount,
                    a.liquidated_quantity,
                    a.liquidated_amount,
                    a.total_items,
                    a.pending_item_count,
                    a.in_progress_item_count,
                    a.liquidated_item_count,
                    a.cancelled_item_count,
                    a.total_assignments,
                    a.pending_count,
                    a.in_progress_count,
                    a.liquidated_count,
                    a.cancelled_count,
                    a.last_assignment_date,
                    COALESCE(rs.total_returned_quantity, 0) as total_returned_quantity,
                    COALESCE(rs.total_returned_amount, 0) as total_returned_amount,
                    COALESCE(rs.return_count, 0) as return_count,
                    (a.pending_quantity + a.in_progress_quantity) as active_quantity,
                    (a.pending_amount + a.in_progress_amount) as active_amount,
                    COALESCE(qbu.quantities_by_unit, '[]'::json) as quantities_by_unit,
                    cos.current_shift_global_id
                FROM assignment_stats a
                LEFT JOIN returns_stats rs ON a.employee_id = rs.employee_id
                LEFT JOIN quantity_by_unit_agg qbu ON a.employee_id = qbu.employee_id
                LEFT JOIN current_open_shifts cos ON a.employee_id = cos.employee_id
                WHERE NOT EXISTS (SELECT 1 FROM current_open_shifts cos2 WHERE cos2.employee_id = a.employee_id)
                `;
            }

            query += ` ORDER BY last_assignment_date DESC NULLS LAST`;

            const result = await pool.query(query, params);

            console.log(`[Repartidores Summary] ✅ Found ${result.rows.length} repartidores with assignments`);

            res.json({
                success: true,
                data: result.rows.map(row => ({
                    employee_id: row.employee_id,
                    employee_global_id: row.employee_global_id,
                    repartidor_name: row.repartidor_name,
                    role_name: row.role_name,
                    branch_id: row.branch_id,
                    branch_name: row.branch_name,
                    current_shift_global_id: row.current_shift_global_id,
                    pending_quantity: parseFloat(row.pending_quantity),
                    pending_amount: parseFloat(row.pending_amount),
                    in_progress_quantity: parseFloat(row.in_progress_quantity),
                    in_progress_amount: parseFloat(row.in_progress_amount),
                    liquidated_quantity: parseFloat(row.liquidated_quantity),
                    liquidated_amount: parseFloat(row.liquidated_amount),
                    active_quantity: parseFloat(row.active_quantity),
                    active_amount: parseFloat(row.active_amount),
                    // Totales agrupados por unidad: [{unit: "kg", quantity: 200, amount: 5000}, {unit: "pz", quantity: 100, amount: 3500}]
                    quantities_by_unit: row.quantities_by_unit || [],
                    total_returned_quantity: parseFloat(row.total_returned_quantity),
                    total_returned_amount: parseFloat(row.total_returned_amount),
                    // Conteos de ASIGNACIONES ÚNICAS (por venta_id)
                    total_assignments: parseInt(row.total_assignments),
                    pending_count: parseInt(row.pending_count),
                    in_progress_count: parseInt(row.in_progress_count),
                    liquidated_count: parseInt(row.liquidated_count),
                    cancelled_count: parseInt(row.cancelled_count),
                    // Conteos de ITEMS/PRODUCTOS (filas individuales)
                    total_items: parseInt(row.total_items),
                    pending_item_count: parseInt(row.pending_item_count),
                    in_progress_item_count: parseInt(row.in_progress_item_count),
                    liquidated_item_count: parseInt(row.liquidated_item_count),
                    cancelled_item_count: parseInt(row.cancelled_item_count),
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
    // 🔧 FIX: Ahora devuelve CADA PRODUCTO INDIVIDUAL (no agrupado por venta)
    // para que las devoluciones se asocien correctamente a cada producto
    router.get('/:employeeId/assignments', authenticateToken, async (req, res) => {
        try {
            const { tenantId, branchId: userBranchId, employeeId: jwtEmployeeId } = req.user;
            const { employeeId } = req.params;
            const { status, limit = 100, offset = 0, only_open_shifts = 'false' } = req.query;

            console.log(`[Repartidor Assignments] 🔍 === REQUEST INFO ===`);
            console.log(`[Repartidor Assignments] JWT User: tenantId=${tenantId}, branchId=${userBranchId}, employeeId=${jwtEmployeeId}`);
            console.log(`[Repartidor Assignments] Params: employeeId=${employeeId} (from URL)`);
            console.log(`[Repartidor Assignments] Query: status=${status || 'ALL'}, only_open_shifts=${only_open_shifts}, limit=${limit}, offset=${offset}`);

            // 🔧 QUERY SIN AGRUPACIÓN - Cada producto es una asignación individual
            // Esto permite asociar devoluciones correctamente a cada producto
            let query = `
                SELECT
                    ra.id,
                    ra.venta_id,
                    ra.employee_id,
                    ra.product_id,
                    ra.product_name,
                    ra.assigned_quantity,
                    ra.assigned_amount,
                    ra.unit_price,
                    COALESCE(ra.unit_abbreviation, 'kg') as unit_abbreviation,
                    -- Status: verificar si la venta fue cancelada
                    CASE
                        WHEN v.status = 'cancelled' THEN 'cancelled'
                        ELSE COALESCE(ra.status, 'pending')
                    END as status,
                    ra.fecha_asignacion,
                    ra.fecha_liquidacion,
                    ra.observaciones,
                    ra.repartidor_shift_id,
                    CONCAT(e_created.first_name, ' ', e_created.last_name) as assigned_by_name,
                    v.ticket_number,
                    CONCAT(e_repartidor.first_name, ' ', e_repartidor.last_name) as repartidor_name,
                    s.is_cash_cut_open as shift_is_open,
                    -- Payment info
                    ra.payment_method_id,
                    ra.cash_amount,
                    ra.card_amount,
                    ra.credit_amount,
                    ra.amount_received,
                    COALESCE(ra.is_credit, false) as is_credit,
                    ra.payment_reference,
                    ra.liquidated_by_employee_id,
                    -- Customer name
                    c.nombre as customer_name,
                    v.status as venta_status
                FROM repartidor_assignments ra
                LEFT JOIN employees e_created ON ra.created_by_employee_id = e_created.id
                LEFT JOIN employees e_repartidor ON ra.employee_id = e_repartidor.id
                LEFT JOIN ventas v ON ra.venta_id = v.id_venta
                LEFT JOIN customers c ON v.id_cliente = c.id
                LEFT JOIN shifts s ON ra.repartidor_shift_id = s.id
                WHERE ra.tenant_id = $1 AND ra.employee_id = $2
            `;

            // Filtrar turnos abiertos si se solicita
            // 🔧 FIX: Devolver TODAS las asignaciones del turno (pending, in_progress Y liquidated)
            // El filtro de status se aplica en el cliente, no aquí
            if (only_open_shifts === 'true') {
                query += ` AND (s.id IS NULL OR s.is_cash_cut_open = true)`;
                // 🔧 Ya NO filtrar por status - incluir pending, in_progress Y liquidated
                // query += ` AND ra.status IN ('pending', 'in_progress')`;  // REMOVED
                query += ` AND (ra.venta_id IS NULL OR v.status NOT IN ('cancelled', 'voided'))`;
                console.log(`[Repartidor Assignments] ✅ Filtrando asignaciones de turnos abiertos (todos los status)`);
            }

            const params = [tenantId, parseInt(employeeId)];
            let paramIndex = 3;

            // Filtrar por status si se proporciona
            if (status && only_open_shifts !== 'true') {
                query += ` AND ra.status = $${paramIndex}`;
                params.push(status);
                paramIndex++;
            }

            query += ` ORDER BY ra.fecha_asignacion DESC, ra.id DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
            params.push(parseInt(limit), parseInt(offset));

            console.log(`[Repartidor Assignments] 📊 Executing query with params:`, params);
            const result = await pool.query(query, params);

            console.log(`[Repartidor Assignments] ✅ Found ${result.rows.length} individual assignments`);

            // Mostrar debug de cada asignación
            result.rows.forEach((row, idx) => {
                console.log(`[Repartidor Assignments] 📦 Row ${idx}: id=${row.id}, venta_id=${row.venta_id}, product="${row.product_name}", status="${row.status}"`);
            });

            // Obtener devoluciones para cada assignment
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
                        rr.notes,
                        rr.product_id,
                        rr.product_name
                    FROM repartidor_returns rr
                    WHERE rr.assignment_id = ANY($1)
                      AND (rr.status IS NULL OR rr.status != 'deleted')
                    ORDER BY rr.return_date DESC
                `;
                const returnsResult = await pool.query(returnsQuery, [assignmentIds]);

                // Agrupar por assignment_id
                returnsResult.rows.forEach(ret => {
                    if (!returnsByAssignment[ret.assignment_id]) {
                        returnsByAssignment[ret.assignment_id] = [];
                    }
                    returnsByAssignment[ret.assignment_id].push({
                        quantity: parseFloat(ret.quantity),
                        amount: parseFloat(ret.amount),
                        return_date: ret.return_date,
                        source: ret.source,
                        notes: ret.notes,
                        product_id: ret.product_id,
                        product_name: ret.product_name
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
                        // Producto individual
                        product_id: row.product_id,
                        product_name: row.product_name,
                        assigned_quantity: parseFloat(row.assigned_quantity),
                        assigned_amount: parseFloat(row.assigned_amount),
                        unit_price: parseFloat(row.unit_price || 0),
                        unit_abbreviation: row.unit_abbreviation || 'kg',
                        status: row.status,
                        fecha_asignacion: row.fecha_asignacion,
                        fecha_liquidacion: row.fecha_liquidacion,
                        assigned_by_name: row.assigned_by_name,
                        observaciones: row.observaciones,
                        repartidor_shift_id: row.repartidor_shift_id,
                        // Items vacío - ahora cada asignación ES un producto
                        items: [{
                            product_id: row.product_id,
                            product_name: row.product_name,
                            quantity: parseFloat(row.assigned_quantity),
                            unit_price: parseFloat(row.unit_price || 0),
                            line_total: parseFloat(row.assigned_amount),
                            unit_abbreviation: row.unit_abbreviation || 'kg'
                        }],
                        // Devoluciones de ESTE assignment específico
                        returns: returns,
                        total_returned_quantity: totalReturnedQuantity,
                        total_returned_amount: totalReturnedAmount,
                        // Payment info
                        // 🔧 FIX: Si está liquidada pero no tiene desglose de pago, asumir efectivo
                        ...(() => {
                            const cashAmt = parseFloat(row.cash_amount || 0);
                            const cardAmt = parseFloat(row.card_amount || 0);
                            const creditAmt = parseFloat(row.credit_amount || 0);
                            const assignedAmt = parseFloat(row.assigned_amount || 0);
                            const isLiquidated = row.status === 'liquidated';
                            const noPaymentBreakdown = (cashAmt + cardAmt + creditAmt) === 0;

                            // Si está liquidada sin desglose, asumir que es efectivo (comportamiento legacy)
                            if (isLiquidated && noPaymentBreakdown && assignedAmt > 0) {
                                return {
                                    payment_method_id: row.payment_method_id ? parseInt(row.payment_method_id) : 1, // 1 = Efectivo
                                    cash_amount: assignedAmt,
                                    card_amount: 0,
                                    credit_amount: 0
                                };
                            }

                            return {
                                payment_method_id: row.payment_method_id ? parseInt(row.payment_method_id) : null,
                                cash_amount: cashAmt,
                                card_amount: cardAmt,
                                credit_amount: creditAmt
                            };
                        })(),
                        amount_received: parseFloat(row.amount_received || 0),
                        is_credit: row.is_credit || false,
                        payment_reference: row.payment_reference,
                        liquidated_by_employee_id: row.liquidated_by_employee_id ? parseInt(row.liquidated_by_employee_id) : null,
                        customer_name: row.customer_name || null
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
                    rr.product_id,
                    rr.product_name,
                    CONCAT(e_registered.first_name, ' ', e_registered.last_name) as registered_by_name,
                    ra.assigned_quantity,
                    ra.assigned_amount,
                    ra.repartidor_shift_id,
                    COALESCE(ra.unit_abbreviation, 'kg') as unit_abbreviation,
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
                    product_id: row.product_id,
                    product_name: row.product_name,
                    registered_by_name: row.registered_by_name,
                    assigned_quantity: parseFloat(row.assigned_quantity),
                    assigned_amount: parseFloat(row.assigned_amount),
                    repartidor_shift_id: row.repartidor_shift_id,
                    unit_abbreviation: row.unit_abbreviation || 'kg'
                }))
            });
        } catch (error) {
            console.error('[Repartidor Returns] Error:', error);
            res.status(500).json({ success: false, message: 'Error al obtener devoluciones', error: error.message });
        }
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
                product_global_id,     // 🆕 GlobalId del producto para trazabilidad de inventario
                product_name,          // 🆕 Nombre del producto (denormalizado)
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

            // 🆕 Product (para trazabilidad de inventario)
            let finalProductId = null;
            if (product_global_id) {
                const productResult = await pool.query(
                    'SELECT id FROM productos WHERE global_id = $1',
                    [product_global_id]
                );
                if (productResult.rows.length > 0) {
                    finalProductId = productResult.rows[0].id;
                    console.log(`[RepartidorReturns] ✅ Producto resuelto: ${product_global_id} → ID ${finalProductId}`);
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
                            product_id = COALESCE($5, product_id),
                            product_name = COALESCE($6, product_name),
                            updated_at = NOW()
                        WHERE global_id = $7
                        RETURNING *
                    `, [quantity, amount, status, notes, finalProductId, product_name, global_id]);

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
                    shift_id, product_id, product_name, quantity, unit_price, amount,
                    return_date, source, status, notes,
                    terminal_id, local_op_seq, created_local_utc, device_event_raw
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
                RETURNING *
            `, [
                global_id,
                finalAssignmentId,       // ✅ Usar el ID resuelto
                finalEmployeeId,         // ✅ Usar el ID resuelto
                finalRegisteredById || finalEmployeeId, // ✅ Usar el ID resuelto
                tenant_id,
                branch_id,
                finalShiftId,            // ✅ Usar el ID resuelto
                finalProductId,          // 🆕 ID del producto resuelto
                product_name || null,    // 🆕 Nombre del producto
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
    // GET /api/repartidores/shifts/:shiftId/cash-snapshot
    // Obtiene el cash snapshot de un turno específico de repartidor
    // ============================================================================
    router.get('/shifts/:shiftId/cash-snapshot', authenticateToken, async (req, res) => {
        try {
            const { tenantId } = req.user;
            const { shiftId } = req.params;
            const { recalculate = 'false' } = req.query;

            console.log(`[Repartidor CashSnapshot] GET - Shift: ${shiftId}, Tenant: ${tenantId}, Recalculate: ${recalculate}`);

            // Verificar que el turno existe y pertenece al tenant
            const shiftResult = await pool.query(`
                SELECT s.*, e.first_name, e.last_name, b.name as branch_name
                FROM shifts s
                INNER JOIN employees e ON s.employee_id = e.id
                INNER JOIN branches b ON s.branch_id = b.id
                WHERE s.id = $1 AND s.tenant_id = $2
            `, [shiftId, tenantId]);

            if (shiftResult.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Turno no encontrado'
                });
            }

            const shift = shiftResult.rows[0];

            // Calcular totales de asignaciones
            const assignmentsResult = await pool.query(`
                SELECT
                    COALESCE(SUM(assigned_quantity), 0) as total_assigned_quantity,
                    COALESCE(SUM(assigned_amount), 0) as total_assigned_amount,
                    COUNT(*) as assignment_count,
                    COUNT(CASE WHEN status = 'liquidated' THEN 1 END) as liquidated_count,
                    COALESCE(SUM(CASE WHEN status = 'liquidated' THEN
                        CASE
                            WHEN COALESCE(cash_amount, 0) + COALESCE(card_amount, 0) + COALESCE(credit_amount, 0) = 0
                            THEN assigned_amount
                            ELSE cash_amount
                        END
                    ELSE 0 END), 0) as total_cash_collected,
                    COALESCE(SUM(CASE WHEN status = 'liquidated' THEN card_amount ELSE 0 END), 0) as total_card_collected,
                    COALESCE(SUM(CASE WHEN status = 'liquidated' THEN credit_amount ELSE 0 END), 0) as total_credit_collected
                FROM repartidor_assignments
                WHERE repartidor_shift_id = $1
                  AND tenant_id = $2
                  AND status NOT IN ('cancelled', 'voided')
            `, [shiftId, tenantId]);

            // Calcular totales de devoluciones
            const returnsResult = await pool.query(`
                SELECT
                    COALESCE(SUM(quantity), 0) as total_returned_quantity,
                    COALESCE(SUM(amount), 0) as total_returned_amount,
                    COUNT(*) as return_count
                FROM repartidor_returns
                WHERE shift_id = $1 AND tenant_id = $2
            `, [shiftId, tenantId]);

            // Calcular totales de gastos
            const expensesResult = await pool.query(`
                SELECT
                    COALESCE(SUM(amount), 0) as total_expenses,
                    COUNT(*) as expense_count
                FROM expenses
                WHERE id_turno = $1 AND tenant_id = $2
            `, [shiftId, tenantId]);

            const assignments = assignmentsResult.rows[0];
            const returns = returnsResult.rows[0];
            const expenses = expensesResult.rows[0];

            // Calcular valores
            const initialAmount = parseFloat(shift.initial_amount) || 0;
            const totalAssignedAmount = parseFloat(assignments.total_assigned_amount) || 0;
            const totalAssignedQuantity = parseFloat(assignments.total_assigned_quantity) || 0;
            const totalReturnedAmount = parseFloat(returns.total_returned_amount) || 0;
            const totalReturnedQuantity = parseFloat(returns.total_returned_quantity) || 0;
            const totalExpenses = parseFloat(expenses.total_expenses) || 0;
            const totalCashCollected = parseFloat(assignments.total_cash_collected) || 0;
            const totalCardCollected = parseFloat(assignments.total_card_collected) || 0;
            const totalCreditCollected = parseFloat(assignments.total_credit_collected) || 0;

            // Neto a entregar = Fondo inicial + Ventas netas - Gastos
            const netSales = totalAssignedAmount - totalReturnedAmount;
            const netAmountToDeliver = initialAmount + netSales - totalExpenses;

            const snapshot = {
                shiftId: parseInt(shiftId),
                employeeId: shift.employee_id,
                employeeName: `${shift.first_name} ${shift.last_name}`,
                branchName: shift.branch_name,
                startTime: shift.start_time,
                endTime: shift.end_time,
                isOpen: shift.is_cash_cut_open,
                initialAmount,
                totalAssignedAmount,
                totalAssignedQuantity,
                totalReturnedAmount,
                totalReturnedQuantity,
                totalExpenses,
                expenseCount: parseInt(expenses.expense_count) || 0,
                assignmentCount: parseInt(assignments.assignment_count) || 0,
                liquidatedCount: parseInt(assignments.liquidated_count) || 0,
                returnCount: parseInt(returns.return_count) || 0,
                totalCashCollected,
                totalCardCollected,
                totalCreditCollected,
                netSales,
                netAmountToDeliver,
                actualCashDelivered: 0, // Se actualiza cuando se cierra el turno
                cashDifference: 0
            };

            console.log(`[Repartidor CashSnapshot] ✅ Snapshot calculado para turno ${shiftId}`);

            res.json({
                success: true,
                data: snapshot
            });

        } catch (error) {
            console.error('[Repartidor CashSnapshot] Error:', error);
            res.status(500).json({
                success: false,
                message: 'Error al obtener cash snapshot',
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

            // Query para obtener turnos con resumen de asignaciones, devoluciones y faltantes
            // IMPORTANTE: Excluimos asignaciones canceladas Y ventas canceladas de los totales
            // FIX: Lógica corregida para excluir asignaciones huérfanas (venta eliminada)
            let query = `
                WITH shift_assignments AS (
                    SELECT
                        ra.repartidor_shift_id,
                        SUM(ra.assigned_quantity) as total_assigned_kg,
                        SUM(ra.assigned_amount) as total_assigned_amount,
                        COUNT(*) as assignment_count,
                        COUNT(CASE WHEN ra.status = 'liquidated' THEN 1 END) as liquidated_count,
                        -- Desglose por tipo de pago (solo asignaciones liquidadas)
                        -- 🔧 FIX: Si liquidada sin desglose de pago, asumir efectivo (comportamiento legacy)
                        COALESCE(SUM(CASE
                            WHEN ra.status = 'liquidated' THEN
                                CASE
                                    WHEN COALESCE(ra.cash_amount, 0) + COALESCE(ra.card_amount, 0) + COALESCE(ra.credit_amount, 0) = 0
                                    THEN ra.assigned_amount  -- Sin desglose = efectivo
                                    ELSE ra.cash_amount
                                END
                            ELSE 0
                        END), 0) as total_cash_amount,
                        COALESCE(SUM(CASE WHEN ra.status = 'liquidated' THEN ra.card_amount ELSE 0 END), 0) as total_card_amount,
                        COALESCE(SUM(CASE WHEN ra.status = 'liquidated' THEN ra.credit_amount ELSE 0 END), 0) as total_credit_amount
                    FROM repartidor_assignments ra
                    LEFT JOIN ventas v ON ra.venta_id = v.id_venta
                    WHERE ra.employee_id = $1 AND ra.tenant_id = $2
                      AND ra.status NOT IN ('cancelled', 'voided')
                      AND (
                        ra.venta_id IS NULL  -- Asignación directa sin venta: OK
                        OR v.status NOT IN ('cancelled', 'voided')  -- Venta existe y no está cancelada
                      )
                    GROUP BY ra.repartidor_shift_id
                ),
                -- Cantidades agrupadas por unidad de medida (para mostrar "60 kg · 2 pz")
                -- IMPORTANTE: Excluimos asignaciones canceladas Y ventas canceladas
                shift_assigned_by_unit AS (
                    SELECT
                        ra.repartidor_shift_id,
                        json_agg(json_build_object(
                            'unit', COALESCE(ra.unit_abbreviation, 'kg'),
                            'quantity', sum_qty,
                            'amount', sum_amt
                        )) as assigned_by_unit
                    FROM (
                        SELECT
                            ra2.repartidor_shift_id,
                            COALESCE(ra2.unit_abbreviation, 'kg') as unit_abbreviation,
                            SUM(ra2.assigned_quantity) as sum_qty,
                            SUM(ra2.assigned_amount) as sum_amt
                        FROM repartidor_assignments ra2
                        LEFT JOIN ventas v ON ra2.venta_id = v.id_venta
                        WHERE ra2.employee_id = $1 AND ra2.tenant_id = $2
                          AND ra2.status NOT IN ('cancelled', 'voided')
                          AND (
                            ra2.venta_id IS NULL
                            OR v.status NOT IN ('cancelled', 'voided')
                          )
                        GROUP BY ra2.repartidor_shift_id, COALESCE(ra2.unit_abbreviation, 'kg')
                    ) ra
                    GROUP BY ra.repartidor_shift_id
                ),
                -- IMPORTANTE: Solo contar devoluciones de asignaciones NO canceladas Y ventas NO canceladas
                shift_returned_by_unit AS (
                    SELECT
                        ra.repartidor_shift_id,
                        json_agg(json_build_object(
                            'unit', COALESCE(ra.unit_abbreviation, 'kg'),
                            'quantity', sum_qty,
                            'amount', sum_amt
                        )) as returned_by_unit
                    FROM (
                        SELECT
                            a.repartidor_shift_id,
                            COALESCE(a.unit_abbreviation, 'kg') as unit_abbreviation,
                            SUM(rr.quantity) as sum_qty,
                            SUM(rr.amount) as sum_amt
                        FROM repartidor_returns rr
                        INNER JOIN repartidor_assignments a ON rr.assignment_id = a.id
                        LEFT JOIN ventas v ON a.venta_id = v.id_venta
                        WHERE rr.employee_id = $1 AND rr.tenant_id = $2
                          AND (rr.status IS NULL OR rr.status NOT IN ('deleted', 'cancelled', 'voided'))
                          AND a.status NOT IN ('cancelled', 'voided')
                          AND (
                            a.venta_id IS NULL
                            OR v.status NOT IN ('cancelled', 'voided')
                          )
                        GROUP BY a.repartidor_shift_id, COALESCE(a.unit_abbreviation, 'kg')
                    ) ra
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
                    LEFT JOIN ventas v ON ra.venta_id = v.id_venta
                    WHERE rr.employee_id = $1 AND rr.tenant_id = $2
                      AND (rr.status IS NULL OR rr.status NOT IN ('deleted', 'cancelled', 'voided'))
                      AND ra.status NOT IN ('cancelled', 'voided')
                      AND (
                        ra.venta_id IS NULL
                        OR v.status NOT IN ('cancelled', 'voided')
                      )
                    GROUP BY ra.repartidor_shift_id
                ),
                shift_expenses AS (
                    SELECT
                        ex.id_turno as shift_id,
                        SUM(ex.amount) as total_expenses,
                        COUNT(*) as expense_count
                    FROM expenses ex
                    WHERE ex.employee_id = $1 AND ex.tenant_id = $2
                      AND ex.is_active = true
                      AND ex.status NOT IN ('cancelled', 'voided', 'draft')
                    GROUP BY ex.id_turno
                ),
                shift_debts AS (
                    SELECT
                        ed.shift_id,
                        SUM(CASE WHEN ed.monto_deuda > 0 THEN ed.monto_deuda ELSE 0 END) as total_debt,
                        SUM(ed.monto_pagado) as total_paid,
                        SUM(CASE WHEN ed.monto_deuda > 0 THEN (ed.monto_deuda - COALESCE(ed.monto_pagado, 0)) ELSE 0 END) as pending_debt,
                        COUNT(*) as debt_count
                    FROM employee_debts ed
                    WHERE ed.employee_id = $1 AND ed.tenant_id = $2
                      AND ed.monto_deuda > 0
                    GROUP BY ed.shift_id
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
                    -- Desglose por tipo de pago (liquidadas)
                    COALESCE(sa.total_cash_amount, 0) as total_cash_amount,
                    COALESCE(sa.total_card_amount, 0) as total_card_amount,
                    COALESCE(sa.total_credit_amount, 0) as total_credit_amount,
                    COALESCE(sr.total_returned_kg, 0) as total_returned_kg,
                    COALESCE(sr.total_returned_amount, 0) as total_returned_amount,
                    COALESCE(sr.return_count, 0) as return_count,
                    COALESCE(se.total_expenses, 0) as total_expenses,
                    COALESCE(se.expense_count, 0) as expense_count,
                    -- Faltantes/Deudas del turno (desde employee_debts)
                    COALESCE(sd.total_debt, 0) as total_debt,
                    COALESCE(sd.pending_debt, 0) as pending_debt,
                    COALESCE(sd.debt_count, 0) as debt_count,
                    -- Neto TOTAL a entregar (Fondo Inicial + Asignado - Devuelto - Gastos) - para compatibilidad
                    (COALESCE(s.initial_amount, 0) + COALESCE(sa.total_assigned_amount, 0) - COALESCE(sr.total_returned_amount, 0) - COALESCE(se.total_expenses, 0)) as net_to_deliver,
                    -- Efectivo esperado = Fondo Inicial + SOLO efectivo liquidado - Gastos
                    -- (devueltas ya se descuentan del assigned_amount antes de aplicar pagos)
                    (COALESCE(s.initial_amount, 0) + COALESCE(sa.total_cash_amount, 0) - COALESCE(se.total_expenses, 0)) as expected_cash,
                    (COALESCE(sa.total_assigned_kg, 0) - COALESCE(sr.total_returned_kg, 0)) as net_delivered_kg,
                    -- Cantidades agrupadas por unidad
                    sabu.assigned_by_unit,
                    srbu.returned_by_unit
                FROM shifts s
                LEFT JOIN employees e ON s.employee_id = e.id
                LEFT JOIN branches b ON s.branch_id = b.id
                LEFT JOIN shift_assignments sa ON s.id = sa.repartidor_shift_id
                LEFT JOIN shift_returns sr ON s.id = sr.repartidor_shift_id
                LEFT JOIN shift_expenses se ON s.id = se.shift_id
                LEFT JOIN shift_debts sd ON s.id = sd.shift_id
                LEFT JOIN shift_assigned_by_unit sabu ON s.id = sabu.repartidor_shift_id
                LEFT JOIN shift_returned_by_unit srbu ON s.id = srbu.repartidor_shift_id
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
                    // Desglose por tipo de pago (liquidadas)
                    total_cash_amount: parseFloat(row.total_cash_amount),
                    total_card_amount: parseFloat(row.total_card_amount),
                    total_credit_amount: parseFloat(row.total_credit_amount),
                    // Devoluciones
                    total_returned_kg: parseFloat(row.total_returned_kg),
                    total_returned_amount: parseFloat(row.total_returned_amount),
                    return_count: parseInt(row.return_count),
                    // Gastos
                    total_expenses: parseFloat(row.total_expenses),
                    expense_count: parseInt(row.expense_count),
                    // Faltantes (desde employee_debts)
                    total_debt: parseFloat(row.total_debt),
                    pending_debt: parseFloat(row.pending_debt),
                    debt_count: parseInt(row.debt_count),
                    // Netos
                    net_to_deliver: parseFloat(row.net_to_deliver),
                    expected_cash: parseFloat(row.expected_cash),  // Efectivo esperado (solo cash liquidado)
                    net_delivered_kg: parseFloat(row.net_delivered_kg),
                    // Cantidades agrupadas por unidad (para mostrar "60 kg · 2 pz")
                    assigned_by_unit: row.assigned_by_unit || [],
                    returned_by_unit: row.returned_by_unit || []
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

            // Calcular total pendiente - SOLO faltantes (valores positivos)
            const totalQuery = await pool.query(`
                SELECT
                    SUM(CASE WHEN monto_deuda > 0 THEN monto_deuda ELSE 0 END) as total_deuda,
                    SUM(monto_pagado) as total_pagado,
                    SUM(CASE WHEN monto_deuda > 0 THEN (monto_deuda - COALESCE(monto_pagado, 0)) ELSE 0 END) as total_pendiente,
                    COUNT(*) as count
                FROM employee_debts
                WHERE employee_id = $1 AND tenant_id = $2 AND estado = 'pendiente'
                  AND monto_deuda > 0
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
