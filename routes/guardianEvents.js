// ═══════════════════════════════════════════════════════════════
// GUARDIAN EVENTS ROUTES - Extracted from server.js
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET;
const notificationHelper = require('../utils/notificationHelper');

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

    // GET /api/guardian-events - Lista de eventos Guardian (MUY IMPORTANTE)
    router.get('/', authenticateToken, async (req, res) => {
        try {
            const { tenantId, branchId: userBranchId } = req.user;
            const { limit = 100, offset = 0, unreadOnly = false, all_branches = 'false', branch_id } = req.query;

            // Prioridad: 1. branch_id del query, 2. branchId del JWT
            const targetBranchId = branch_id ? parseInt(branch_id) : userBranchId;

            let query = `
                SELECT g.id, g.event_type, g.severity, g.title, g.description,
                       g.weight_kg, g.scale_id, g.metadata, g.is_read, g.event_date,
                       e.full_name as employee_name, b.name as branch_name, b.id as branch_id
                FROM guardian_events g
                LEFT JOIN employees e ON g.employee_id = e.id
                LEFT JOIN branches b ON g.branch_id = b.id
                WHERE g.tenant_id = $1
            `;

            const params = [tenantId];
            let paramIndex = 2;

            // Filtrar por branch_id si no se solicita ver todas
            if (all_branches !== 'true' && targetBranchId) {
                query += ` AND g.branch_id = $${paramIndex}`;
                params.push(targetBranchId);
                paramIndex++;
            }

            if (unreadOnly === 'true') {
                query += ' AND g.is_read = false';
            }

            query += ` ORDER BY g.event_date DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
            params.push(limit, offset);

            console.log(`[Guardian Events] Fetching events - Tenant: ${tenantId}, Branch: ${targetBranchId}, all_branches: ${all_branches}, unreadOnly: ${unreadOnly}`);

            const result = await pool.query(query, params);

            res.json({
                success: true,
                data: result.rows
            });
        } catch (error) {
            console.error('[Guardian Events] Error:', error);
            res.status(500).json({ success: false, message: 'Error al obtener eventos Guardian' });
        }
    });

    // POST /api/guardian-events - Crear evento Guardian (desde Desktop)
    // Nota: Sin autenticación porque el evento ya incluye tenantId, branchId y employeeId del payload
    router.post('/', async (req, res) => {
        try {
            const { tenantId, branchId, employeeId, eventType, severity, title, description, weightKg, scaleId, metadata, employeeName } = req.body;

            // Validar que tenemos los datos requeridos
            if (!tenantId || !branchId || !employeeId || !eventType) {
                return res.status(400).json({ success: false, message: 'Faltan campos requeridos: tenantId, branchId, employeeId, eventType' });
            }

            const result = await pool.query(
                `INSERT INTO guardian_events (tenant_id, branch_id, employee_id, event_type, severity, title, description, weight_kg, scale_id, metadata)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                 RETURNING *`,
                [tenantId, branchId, employeeId, eventType, severity, title, description, weightKg, scaleId, metadata ? JSON.stringify(metadata) : null]
            );

            const event = result.rows[0];
            const finalEmployeeName = employeeName || `Employee_${employeeId}`;  // Usar nombre si viene, si no usar ID

            console.log(`[Guardian Events] 🚨 Evento creado: ${eventType} - ${title} (Empleado: ${finalEmployeeName})`);

            // ✅ Notificación en tiempo real vía Socket.IO
            // Emitir evento al room de la sucursal específica para que móviles lo reciban
            if (io && event.branch_id) {
                io.to(`branch_${event.branch_id}`).emit('scale_alert', {
                    branchId: event.branch_id,
                    alertId: event.id,
                    severity: event.severity,
                    eventType: event.event_type,
                    weightDetected: event.weight_kg || 0,
                    details: event.description || '',
                    timestamp: event.event_date,
                    employeeName: finalEmployeeName,  // ← Usar nombre real
                    receivedAt: new Date().toISOString(),
                    source: 'api'  // Indicar que viene del endpoint API
                });

                console.log(`[Guardian Events] 📡 Evento 'scale_alert' emitido a branch_${event.branch_id} para app móvil (Empleado: ${finalEmployeeName})`);
            }

            // ✅ Enviar notificación FCM a dispositivos móviles
            if (event.branch_id) {
                try {
                    await notificationHelper.notifyScaleAlert(event.branch_id, {
                        severity: event.severity || 'medium',
                        eventType: event.event_type,
                        details: event.description || 'Alerta de báscula detectada',
                        employeeName: finalEmployeeName  // ← Usar nombre real
                    });
                    console.log(`[Guardian Events] ✅ FCM enviado: ${eventType} (${finalEmployeeName})`);
                } catch (fcmError) {
                    console.error(`[Guardian Events] ⚠️ Error enviando FCM: ${fcmError.message}`);
                    // No fallar si hay error en FCM
                }
            }

            res.json({ success: true, data: event, message: 'Evento Guardian guardado y notificación enviada' });
        } catch (error) {
            console.error('[Guardian Events] Error:', error);
            res.status(500).json({ success: false, message: 'Error al crear evento Guardian' });
        }
    });

    // PUT /api/guardian-events/:id/mark-read - Marcar evento como leído
    router.put('/:id/mark-read', authenticateToken, async (req, res) => {
        try {
            const { tenantId } = req.user;
            const { id } = req.params;

            const result = await pool.query(
                `UPDATE guardian_events
                 SET is_read = true
                 WHERE id = $1 AND tenant_id = $2
                 RETURNING *`,
                [id, tenantId]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({ success: false, message: 'Evento no encontrado' });
            }

            res.json({ success: true, data: result.rows[0] });
        } catch (error) {
            console.error('[Guardian Events] Error:', error);
            res.status(500).json({ success: false, message: 'Error al marcar evento' });
        }
    });

    return router;
};
