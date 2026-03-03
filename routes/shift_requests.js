// ═══════════════════════════════════════════════════════════════
// SHIFT REQUESTS — Solicitudes de turno desde app móvil
// ═══════════════════════════════════════════════════════════════
const express = require('express');
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET;

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

    // Import notification helpers
    let sendNotificationToAdminsInTenant, sendNotificationToEmployee;
    try {
        const notificationHelper = require('../utils/notificationHelper');
        sendNotificationToAdminsInTenant = notificationHelper.sendNotificationToAdminsInTenant;
        sendNotificationToEmployee = notificationHelper.sendNotificationToEmployee;
    } catch (e) {
        console.warn('[ShiftRequests] ⚠️ notificationHelper not available, FCM disabled');
    }

    // ═══════════════════════════════════════════════════════════════
    // POST /api/shift-requests — Repartidor solicita apertura de turno
    // ═══════════════════════════════════════════════════════════════
    router.post('/', authenticateToken, async (req, res) => {
        try {
            const { tenantId, employeeId, branchId } = req.user;

            // Check if employee already has an open shift
            const existingShift = await pool.query(
                `SELECT id FROM shifts
                 WHERE tenant_id = $1 AND employee_id = $2 AND is_cash_cut_open = true`,
                [tenantId, employeeId]
            );
            if (existingShift.rows.length > 0) {
                return res.status(400).json({
                    success: false,
                    message: 'Ya tienes un turno abierto'
                });
            }

            // Check if there's already a pending request
            const existingRequest = await pool.query(
                `SELECT id FROM shift_requests
                 WHERE employee_id = $1 AND status = 'pending'`,
                [employeeId]
            );
            if (existingRequest.rows.length > 0) {
                return res.status(400).json({
                    success: false,
                    message: 'Ya tienes una solicitud pendiente'
                });
            }

            // Create the request
            const result = await pool.query(
                `INSERT INTO shift_requests (tenant_id, branch_id, employee_id, status)
                 VALUES ($1, $2, $3, 'pending')
                 RETURNING id, tenant_id, branch_id, employee_id, status, requested_at`,
                [tenantId, branchId, employeeId]
            );
            const request = result.rows[0];

            // Get employee name and branch name for notifications
            const empResult = await pool.query(
                `SELECT e.first_name, e.last_name, e.global_id, b.name as branch_name
                 FROM employees e
                 JOIN branches b ON b.id = $2
                 WHERE e.id = $1`,
                [employeeId, branchId]
            );
            const employeeName = empResult.rows[0]
                ? `${empResult.rows[0].first_name} ${empResult.rows[0].last_name}`.trim()
                : 'Repartidor';
            const branchName = empResult.rows[0]?.branch_name || 'Sucursal';

            // Emit socket event to branch room
            if (io) {
                const roomName = `branch_${branchId}`;
                console.log(`[ShiftRequests] 📡 Emitiendo 'shift_request_new' a ${roomName}`);
                io.to(roomName).emit('shift_request_new', {
                    requestId: request.id,
                    employeeId,
                    employeeName,
                    branchId,
                    branchName,
                    requestedAt: request.requested_at
                });
            }

            // FCM push to admins
            if (sendNotificationToAdminsInTenant) {
                sendNotificationToAdminsInTenant(tenantId, {
                    title: `📋 Solicitud de Turno [${branchName}]`,
                    body: `${employeeName} solicita abrir su turno`,
                    data: {
                        type: 'shift_request_new',
                        requestId: request.id.toString(),
                        employeeId: employeeId.toString(),
                        employeeName,
                        branchId: branchId.toString()
                    }
                });
            }

            console.log(`[ShiftRequests] ✅ Solicitud #${request.id} creada - ${employeeName}`);
            res.json({ success: true, data: request });

        } catch (error) {
            console.error('[ShiftRequests] ❌ Error creando solicitud:', error);
            res.status(500).json({ success: false, message: 'Error al crear solicitud' });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // GET /api/shift-requests/my-pending — Repartidor verifica su solicitud
    // ═══════════════════════════════════════════════════════════════
    router.get('/my-pending', authenticateToken, async (req, res) => {
        try {
            const { employeeId } = req.user;

            const result = await pool.query(
                `SELECT id, status, requested_at, rejection_reason
                 FROM shift_requests
                 WHERE employee_id = $1 AND status IN ('pending', 'rejected')
                 ORDER BY requested_at DESC
                 LIMIT 1`,
                [employeeId]
            );

            if (result.rows.length === 0) {
                return res.json({ success: true, data: null });
            }

            res.json({ success: true, data: result.rows[0] });

        } catch (error) {
            console.error('[ShiftRequests] ❌ Error consultando solicitud:', error);
            res.status(500).json({ success: false, message: 'Error al consultar solicitud' });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // GET /api/shift-requests/pending — Desktop obtiene solicitudes pendientes
    // ═══════════════════════════════════════════════════════════════
    router.get('/pending', authenticateToken, async (req, res) => {
        try {
            const { tenantId } = req.user;
            const branchId = req.query.branch_id;

            let query = `
                SELECT sr.id, sr.employee_id, sr.branch_id, sr.status, sr.requested_at,
                       e.first_name, e.last_name, e.global_id as employee_global_id,
                       b.name as branch_name
                FROM shift_requests sr
                JOIN employees e ON e.id = sr.employee_id
                JOIN branches b ON b.id = sr.branch_id
                WHERE sr.tenant_id = $1 AND sr.status = 'pending'
            `;
            const params = [tenantId];

            if (branchId) {
                query += ` AND sr.branch_id = $2`;
                params.push(branchId);
            }

            query += ` ORDER BY sr.requested_at ASC`;

            const result = await pool.query(query, params);

            const requests = result.rows.map(r => ({
                id: r.id,
                employeeId: r.employee_id,
                employeeName: `${r.first_name} ${r.last_name}`.trim(),
                employeeGlobalId: r.employee_global_id,
                branchId: r.branch_id,
                branchName: r.branch_name,
                status: r.status,
                requestedAt: r.requested_at
            }));

            res.json({ success: true, data: requests });

        } catch (error) {
            console.error('[ShiftRequests] ❌ Error obteniendo solicitudes:', error);
            res.status(500).json({ success: false, message: 'Error al obtener solicitudes' });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // POST /api/shift-requests/:id/approve — Desktop aprueba solicitud
    // ═══════════════════════════════════════════════════════════════
    router.post('/:id/approve', authenticateToken, async (req, res) => {
        try {
            const requestId = parseInt(req.params.id);
            const { employeeId: adminId } = req.user;
            const { shiftId } = req.body; // Optional: link to the shift created by Desktop

            const result = await pool.query(
                `UPDATE shift_requests
                 SET status = 'approved', resolved_at = NOW(), resolved_by = $2, shift_id = $3
                 WHERE id = $1 AND status = 'pending'
                 RETURNING id, employee_id, branch_id`,
                [requestId, adminId, shiftId || null]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Solicitud no encontrada o ya fue resuelta'
                });
            }

            const request = result.rows[0];

            // Emit socket event so mobile knows the request was resolved
            if (io) {
                const roomName = `branch_${request.branch_id}`;
                io.to(roomName).emit('shift_request_resolved', {
                    requestId: request.id,
                    employeeId: request.employee_id,
                    status: 'approved'
                });
            }

            console.log(`[ShiftRequests] ✅ Solicitud #${requestId} aprobada`);
            res.json({ success: true, message: 'Solicitud aprobada' });

        } catch (error) {
            console.error('[ShiftRequests] ❌ Error aprobando solicitud:', error);
            res.status(500).json({ success: false, message: 'Error al aprobar solicitud' });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // POST /api/shift-requests/:id/reject — Desktop rechaza solicitud
    // ═══════════════════════════════════════════════════════════════
    router.post('/:id/reject', authenticateToken, async (req, res) => {
        try {
            const requestId = parseInt(req.params.id);
            const { employeeId: adminId } = req.user;
            const { reason } = req.body;

            const result = await pool.query(
                `UPDATE shift_requests
                 SET status = 'rejected', rejection_reason = $2, resolved_at = NOW(), resolved_by = $3
                 WHERE id = $1 AND status = 'pending'
                 RETURNING id, employee_id, branch_id`,
                [requestId, reason || null, adminId]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Solicitud no encontrada o ya fue resuelta'
                });
            }

            const request = result.rows[0];

            // Emit socket event
            if (io) {
                const roomName = `branch_${request.branch_id}`;
                io.to(roomName).emit('shift_request_resolved', {
                    requestId: request.id,
                    employeeId: request.employee_id,
                    status: 'rejected',
                    rejectionReason: reason || null
                });
            }

            // FCM to the employee
            if (sendNotificationToEmployee) {
                const empResult = await pool.query(
                    `SELECT global_id FROM employees WHERE id = $1`,
                    [request.employee_id]
                );
                if (empResult.rows.length > 0) {
                    sendNotificationToEmployee(empResult.rows[0].global_id, {
                        title: 'Solicitud de turno rechazada',
                        body: reason ? `Razón: ${reason}` : 'Tu solicitud fue rechazada',
                        data: { type: 'shift_request_rejected' }
                    });
                }
            }

            console.log(`[ShiftRequests] ❌ Solicitud #${requestId} rechazada`);
            res.json({ success: true, message: 'Solicitud rechazada' });

        } catch (error) {
            console.error('[ShiftRequests] ❌ Error rechazando solicitud:', error);
            res.status(500).json({ success: false, message: 'Error al rechazar solicitud' });
        }
    });

    return router;
};
