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

    // GET /api/guardian-events - Lista de eventos Guardian
    // ⚠️ NOTA: La tabla guardian_events fue refactorizada
    // Los eventos ahora se agregan como contadores en cash_cuts (unregistered_weight_events, scale_connection_events, cancelled_sales)
    // Este endpoint retorna un array vacío por compatibilidad con versiones anteriores del cliente
    router.get('/', authenticateToken, async (req, res) => {
        try {
            const { tenantId, branchId: userBranchId } = req.user;
            const { branch_id } = req.query;

            const targetBranchId = branch_id ? parseInt(branch_id) : userBranchId;

            console.log(`[Guardian Events] ⚠️ Tabla guardian_events no existe - retornando array vacío (Tenant: ${tenantId}, Branch: ${targetBranchId})`);
            console.log(`[Guardian Events] Los eventos Guardian ahora se rastrean como agregados en la tabla cash_cuts`);

            // Retornar array vacío por compatibilidad
            res.json({
                success: true,
                data: [],
                message: 'Guardian events functionality has been refactored. Events are now tracked as aggregates in cash_cuts table.'
            });
        } catch (error) {
            console.error('[Guardian Events] Error:', error);
            res.status(500).json({ success: false, message: 'Error al obtener eventos Guardian' });
        }
    });

    // POST /api/guardian-events - Crear evento Guardian (desde Desktop)
    // ⚠️ NOTA: La tabla guardian_events fue refactorizada
    // Los eventos ahora se agregan como contadores en cash_cuts
    // Este endpoint acepta el evento pero solo emite notificaciones Socket.IO/FCM (no persiste en DB)
    router.post('/', authenticateToken, async (req, res) => {
        try {
            const { tenantId, branchId, employeeId, eventType, severity, title, description, weightKg, scaleId, metadata, employeeName, is_practice } = req.body;
            const isPractice = is_practice === true;

            // Validar que tenemos los datos requeridos
            if (!tenantId || !branchId || !employeeId || !eventType) {
                return res.status(400).json({ success: false, message: 'Faltan campos requeridos: tenantId, branchId, employeeId, eventType' });
            }

            const finalEmployeeName = employeeName || `Employee_${employeeId}`;

            console.log(`[Guardian Events] 🚨 Evento recibido: ${eventType} - ${title} (Empleado: ${finalEmployeeName})${isPractice ? ' [PRÁCTICA]' : ''}`);

            if (isPractice) {
                // Practice mode: prefix FCM title, save notification with is_practice,
                // do NOT save to suspicious_weighing_logs
                console.log(`[Guardian Events] 🎓 Evento de práctica — no se guarda en suspicious_weighing_logs`);

                if (branchId) {
                    try {
                        const practiceTitle = `[PRÁCTICA] ${title || eventType}`;
                        await notificationHelper.sendNotificationToAdminsInBranch(branchId, {
                            title: practiceTitle,
                            body: description || `${finalEmployeeName}: ${eventType} (${severity || 'medium'})`,
                            data: {
                                type: 'scale_alert',
                                is_practice: 'true',
                                branchId: branchId.toString(),
                                eventType
                            }
                        }, { notificationType: 'notify_guardian' });

                        // Save notification with is_practice = true
                        await pool.query(
                            `INSERT INTO notifications (tenant_id, branch_id, employee_id, category, event_type, title, body, data, is_practice)
                             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                            [tenantId, branchId, null, 'security', 'scale_alert_practice', practiceTitle,
                             description || `${finalEmployeeName}: ${eventType}`,
                             JSON.stringify({ eventType, severity, employeeName: finalEmployeeName, is_practice: true }),
                             true]
                        );
                        console.log(`[Guardian Events] ✅ FCM de práctica enviado: ${eventType} (${finalEmployeeName})`);
                    } catch (fcmError) {
                        console.error(`[Guardian Events] ⚠️ Error enviando FCM de práctica: ${fcmError.message}`);
                    }
                }
            } else {
                console.log(`[Guardian Events] ⚠️ Tabla guardian_events no existe - enviando solo notificación FCM`);

                // ✅ Enviar notificación FCM a dispositivos móviles (filtrada por rol)
                if (branchId) {
                    try {
                        await notificationHelper.notifyScaleAlert(branchId, {
                            severity: severity || 'medium',
                            eventType: eventType,
                            details: description || 'Alerta de báscula detectada',
                            employeeName: finalEmployeeName
                        });
                        console.log(`[Guardian Events] ✅ FCM enviado: ${eventType} (${finalEmployeeName})`);
                    } catch (fcmError) {
                        console.error(`[Guardian Events] ⚠️ Error enviando FCM: ${fcmError.message}`);
                        // No fallar si hay error en FCM
                    }
                }
            }

            res.json({
                success: true,
                data: { id: null, event_type: eventType, severity, title, description, is_practice: isPractice },
                message: isPractice
                    ? 'Guardian practice event notification sent (not persisted to suspicious_weighing_logs)'
                    : 'Guardian event notification sent (not persisted to database)'
            });
        } catch (error) {
            console.error('[Guardian Events] Error:', error);
            res.status(500).json({ success: false, message: 'Error al procesar evento Guardian' });
        }
    });

    // PUT /api/guardian-events/:id/mark-read - Marcar evento como leído
    // ⚠️ NOTA: La tabla guardian_events fue refactorizada - este endpoint retorna success por compatibilidad
    router.put('/:id/mark-read', authenticateToken, async (req, res) => {
        try {
            const { tenantId } = req.user;
            const { id } = req.params;

            console.log(`[Guardian Events] ⚠️ PUT /:id/mark-read llamado pero tabla no existe (ID: ${id}, Tenant: ${tenantId})`);

            // Retornar success por compatibilidad con clientes antiguos
            res.json({
                success: true,
                data: { id, is_read: true },
                message: 'Guardian events functionality has been refactored'
            });
        } catch (error) {
            console.error('[Guardian Events] Error:', error);
            res.status(500).json({ success: false, message: 'Error al marcar evento' });
        }
    });

    return router;
};
