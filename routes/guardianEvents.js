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
    router.post('/', async (req, res) => {
        try {
            const { tenantId, branchId, employeeId, eventType, severity, title, description, weightKg, scaleId, metadata, employeeName } = req.body;

            // Validar que tenemos los datos requeridos
            if (!tenantId || !branchId || !employeeId || !eventType) {
                return res.status(400).json({ success: false, message: 'Faltan campos requeridos: tenantId, branchId, employeeId, eventType' });
            }

            const finalEmployeeName = employeeName || `Employee_${employeeId}`;

            console.log(`[Guardian Events] 🚨 Evento recibido: ${eventType} - ${title} (Empleado: ${finalEmployeeName})`);
            console.log(`[Guardian Events] ⚠️ Tabla guardian_events no existe - solo emitiendo notificación Socket.IO`);

            // ✅ Notificación en tiempo real vía Socket.IO
            // Emitir evento al room de la sucursal específica para que móviles lo reciban
            if (io && branchId) {
                io.to(`branch_${branchId}`).emit('scale_alert', {
                    branchId: branchId,
                    alertId: null,  // No hay ID porque no se persiste
                    severity: severity || 'medium',
                    eventType: eventType,
                    weightDetected: weightKg || 0,
                    details: description || '',
                    timestamp: new Date().toISOString(),
                    employeeName: finalEmployeeName,
                    receivedAt: new Date().toISOString(),
                    source: 'api'
                });

                console.log(`[Guardian Events] 📡 Evento 'scale_alert' emitido a branch_${branchId} para app móvil (Empleado: ${finalEmployeeName})`);
            }

            // ✅ Enviar notificación FCM a dispositivos móviles
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

            res.json({
                success: true,
                data: { id: null, event_type: eventType, severity, title, description },
                message: 'Guardian event notification sent (not persisted to database)'
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
