// ═══════════════════════════════════════════════════════════════
// SHIFTS ROUTES - Extracted from server.js
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
            const { tenantId, employeeId, branchId } = req.user;

            // Mobile JWT no incluye branchId, así que filtramos solo por tenantId y employeeId
            // Desktop JWT incluye branchId, así que podemos filtrar por sucursal específica
            let query = `
                SELECT s.id, s.tenant_id, s.branch_id, s.employee_id, s.start_time, s.end_time,
                       s.initial_amount, s.final_amount, s.transaction_counter, s.is_cash_cut_open,
                       e.full_name as employee_name,
                       b.name as branch_name
                FROM shifts s
                LEFT JOIN employees e ON s.employee_id = e.id
                LEFT JOIN branches b ON s.branch_id = b.id
                WHERE s.tenant_id = $1 AND s.employee_id = $2 AND s.is_cash_cut_open = true`;

            const params = [tenantId, employeeId];

            // Si el JWT incluye branchId (Desktop), filtrar por sucursal
            if (branchId) {
                query += ' AND s.branch_id = $3';
                params.push(branchId);
            }

            query += ' ORDER BY s.start_time DESC LIMIT 1';

            console.log(`[Shifts Current] Fetching current shift - Tenant: ${tenantId}, Employee: ${employeeId}, Branch: ${branchId || 'all'}`);

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
    router.get('/history', authenticateToken, async (req, res) => {
        try {
            const { tenantId, branchId } = req.user;
            const { limit = 50, offset = 0, all_branches = 'false', employee_id } = req.query;

            let query = `
                SELECT s.id, s.tenant_id, s.branch_id, s.employee_id, s.start_time, s.end_time,
                       s.initial_amount, s.final_amount, s.transaction_counter, s.is_cash_cut_open,
                       e.full_name as employee_name, e.role as employee_role,
                       b.name as branch_name
                FROM shifts s
                LEFT JOIN employees e ON s.employee_id = e.id
                LEFT JOIN branches b ON s.branch_id = b.id
                WHERE s.tenant_id = $1
            `;

            const params = [tenantId];
            let paramIndex = 2;

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

            query += ` ORDER BY s.start_time DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
            params.push(limit, offset);

            const result = await pool.query(query, params);

            // Format timestamps as ISO strings in UTC
            const formattedRows = result.rows.map(row => ({
                ...row,
                start_time: row.start_time ? new Date(row.start_time).toISOString() : null,
                end_time: row.end_time ? new Date(row.end_time).toISOString() : null
            }));

            res.json({
                success: true,
                data: formattedRows
            });

        } catch (error) {
            console.error('[Shifts] Error al obtener historial:', error);
            res.status(500).json({ success: false, message: 'Error al obtener historial de turnos' });
        }
    });

    // GET /api/shifts/summary - Resumen de cortes de caja (para administradores)
    router.get('/summary', authenticateToken, async (req, res) => {
        try {
            const { tenantId } = req.user;
            const { date_from, date_to, branch_id } = req.query;

            let query = `
                SELECT s.id, s.branch_id, s.employee_id, s.start_time, s.end_time,
                       s.initial_amount, s.final_amount, s.transaction_counter, s.is_cash_cut_open,
                       e.full_name as employee_name,
                       b.name as branch_name,
                       (s.final_amount - s.initial_amount) as difference
                FROM shifts s
                LEFT JOIN employees e ON s.employee_id = e.id
                LEFT JOIN branches b ON s.branch_id = b.id
                WHERE s.tenant_id = $1
            `;

            const params = [tenantId];
            let paramIndex = 2;

            if (branch_id) {
                query += ` AND s.branch_id = $${paramIndex}`;
                params.push(branch_id);
                paramIndex++;
            }

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

            // Calcular totales
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
    router.post('/sync/open', async (req, res) => {
        try {
            const { tenantId, branchId, employeeId, initialAmount, userEmail } = req.body;

            console.log(`[Sync/Shifts] Desktop sync - Tenant: ${tenantId}, Branch: ${branchId}, Employee: ${employeeId}`);

            if (!tenantId || !branchId || !employeeId) {
                return res.status(400).json({
                    success: false,
                    message: 'Datos incompletos (tenantId, branchId, employeeId requeridos)'
                });
            }

            // Verificar si hay un turno abierto para este empleado
            const existingShift = await pool.query(
                `SELECT id FROM shifts
                 WHERE tenant_id = $1 AND branch_id = $2 AND employee_id = $3 AND is_cash_cut_open = true`,
                [tenantId, branchId, employeeId]
            );

            if (existingShift.rows.length > 0) {
                console.log(`[Sync/Shifts] ⚠️ Ya existe turno abierto: ID ${existingShift.rows[0].id}`);
                return res.status(400).json({
                    success: false,
                    message: 'Ya hay un turno abierto para este empleado',
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
            console.log(`[Sync/Shifts] ✅ Turno sincronizado desde Desktop: ID ${shift.id} - Employee ${employeeId} - Branch ${branchId} - Initial $${initialAmount}`);

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

    return router;
};
