// ═══════════════════════════════════════════════════════════════
// ROUTES: NOTIFICACIONES FCM
// Gestiona device tokens y envía notificaciones push
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const { pool } = require('../database');
const { sendNotificationToDevice, sendNotificationToMultipleDevices } = require('../utils/firebaseAdmin');
const router = express.Router();

// ═══════════════════════════════════════════════════════════════
// POST /api/notifications/register-device
// Registra un dispositivo para recibir notificaciones
// ═══════════════════════════════════════════════════════════════
router.post('/register-device', async (req, res) => {
    const { employeeId, branchId, deviceToken, platform, deviceName } = req.body;

    // Validaciones
    if (!employeeId || !branchId || !deviceToken || !platform) {
        return res.status(400).json({
            success: false,
            message: 'Missing required fields: employeeId, branchId, deviceToken, platform'
        });
    }

    if (!['android', 'ios'].includes(platform)) {
        return res.status(400).json({
            success: false,
            message: 'Platform must be "android" or "ios"'
        });
    }

    try {
        // Verificar que el empleado existe
        const employeeResult = await pool.query(
            'SELECT id FROM employees WHERE id = $1',
            [employeeId]
        );

        if (employeeResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Employee not found'
            });
        }

        // Verificar que la sucursal existe
        const branchResult = await pool.query(
            'SELECT id FROM branches WHERE id = $1',
            [branchId]
        );

        if (branchResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Branch not found'
            });
        }

        // Insertar o actualizar el device token
        const query = `
            INSERT INTO device_tokens (employee_id, branch_id, device_token, platform, device_name, last_used_at)
            VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
            ON CONFLICT (device_token)
            DO UPDATE SET
                employee_id = $1,
                branch_id = $2,
                platform = $4,
                device_name = $5,
                is_active = true,
                last_used_at = CURRENT_TIMESTAMP
            RETURNING id, device_token, platform;
        `;

        const result = await pool.query(query, [
            employeeId,
            branchId,
            deviceToken,
            platform,
            deviceName || `Device-${new Date().getTime()}`
        ]);

        console.log(`[Notifications] ✅ Device registered: Employee ${employeeId} - ${platform} - ${result.rows[0].device_token.substring(0, 20)}...`);

        res.json({
            success: true,
            message: 'Device registered successfully',
            deviceId: result.rows[0].id
        });

    } catch (error) {
        console.error('[Notifications] ❌ Error registering device:', error.message);
        res.status(500).json({
            success: false,
            message: 'Error registering device',
            error: error.message
        });
    }
});

// ═══════════════════════════════════════════════════════════════
// POST /api/notifications/unregister-device
// Desregistra un dispositivo
// ═══════════════════════════════════════════════════════════════
router.post('/unregister-device', async (req, res) => {
    const { deviceToken } = req.body;

    if (!deviceToken) {
        return res.status(400).json({
            success: false,
            message: 'deviceToken is required'
        });
    }

    try {
        await pool.query(
            'UPDATE device_tokens SET is_active = false WHERE device_token = $1',
            [deviceToken]
        );

        console.log(`[Notifications] ✅ Device unregistered: ${deviceToken.substring(0, 20)}...`);

        res.json({
            success: true,
            message: 'Device unregistered successfully'
        });

    } catch (error) {
        console.error('[Notifications] ❌ Error unregistering device:', error.message);
        res.status(500).json({
            success: false,
            message: 'Error unregistering device',
            error: error.message
        });
    }
});

// ═══════════════════════════════════════════════════════════════
// POST /api/notifications/send-to-branch
// Envía notificación a todos los dispositivos de una sucursal
// ═══════════════════════════════════════════════════════════════
router.post('/send-to-branch', async (req, res) => {
    const { branchId, title, body, data } = req.body;

    if (!branchId || !title || !body) {
        return res.status(400).json({
            success: false,
            message: 'Missing required fields: branchId, title, body'
        });
    }

    try {
        // Obtener todos los dispositivos activos de la sucursal
        const result = await pool.query(
            `SELECT device_token FROM device_tokens
             WHERE branch_id = $1 AND is_active = true`,
            [branchId]
        );

        const deviceTokens = result.rows.map(row => row.device_token);

        if (deviceTokens.length === 0) {
            return res.json({
                success: true,
                message: 'No active devices in this branch',
                sent: 0
            });
        }

        // Enviar notificaciones
        const results = await sendNotificationToMultipleDevices(deviceTokens, {
            title,
            body,
            data
        });

        const successCount = results.filter(r => r.success).length;

        console.log(`[Notifications] ✅ Sent to branch ${branchId}: ${successCount}/${deviceTokens.length}`);

        // Remover tokens inválidos
        const invalidTokens = results
            .filter(r => r.result === 'INVALID_TOKEN')
            .map(r => r.deviceToken);

        if (invalidTokens.length > 0) {
            await pool.query(
                `UPDATE device_tokens SET is_active = false
                 WHERE device_token = ANY($1)`,
                [invalidTokens]
            );
            console.log(`[Notifications] 🧹 Removed ${invalidTokens.length} invalid tokens`);
        }

        res.json({
            success: true,
            message: 'Notifications sent',
            total: deviceTokens.length,
            sent: successCount,
            failed: deviceTokens.length - successCount
        });

    } catch (error) {
        console.error('[Notifications] ❌ Error sending notifications:', error.message);
        res.status(500).json({
            success: false,
            message: 'Error sending notifications',
            error: error.message
        });
    }
});

// ═══════════════════════════════════════════════════════════════
// POST /api/notifications/send-to-employee
// Envía notificación a todos los dispositivos de un empleado
// ═══════════════════════════════════════════════════════════════
router.post('/send-to-employee', async (req, res) => {
    const { employeeId, title, body, data } = req.body;

    if (!employeeId || !title || !body) {
        return res.status(400).json({
            success: false,
            message: 'Missing required fields: employeeId, title, body'
        });
    }

    try {
        const result = await pool.query(
            `SELECT device_token FROM device_tokens
             WHERE employee_id = $1 AND is_active = true`,
            [employeeId]
        );

        const deviceTokens = result.rows.map(row => row.device_token);

        if (deviceTokens.length === 0) {
            return res.json({
                success: true,
                message: 'No active devices for this employee',
                sent: 0
            });
        }

        const results = await sendNotificationToMultipleDevices(deviceTokens, {
            title,
            body,
            data
        });

        const successCount = results.filter(r => r.success).length;

        console.log(`[Notifications] ✅ Sent to employee ${employeeId}: ${successCount}/${deviceTokens.length}`);

        res.json({
            success: true,
            message: 'Notifications sent',
            total: deviceTokens.length,
            sent: successCount,
            failed: deviceTokens.length - successCount
        });

    } catch (error) {
        console.error('[Notifications] ❌ Error sending notifications:', error.message);
        res.status(500).json({
            success: false,
            message: 'Error sending notifications',
            error: error.message
        });
    }
});

// ═══════════════════════════════════════════════════════════════
// POST /api/notifications/send-event
// Envía notificación de evento (login, cash-cut) con timestamp del cliente
// Soporta offline-first con tracking de sincronización
// ═══════════════════════════════════════════════════════════════
router.post('/send-event', async (req, res) => {
    const {
        employeeId,
        tenantId,
        eventType, // 'login' | 'cash-cut-created' | 'cash-cut-closed'
        userName,
        scaleStatus, // 'connected' | 'disconnected' | null
        eventTime, // ISO timestamp from client
        data = {}
    } = req.body;

    // Validaciones
    if (!employeeId || !tenantId || !eventType || !userName || !eventTime) {
        return res.status(400).json({
            success: false,
            message: 'Missing required fields: employeeId, tenantId, eventType, userName, eventTime'
        });
    }

    // Solo enviar notificaciones de login si hay báscula configurada
    if (eventType === 'login' && scaleStatus === null) {
        console.log(`[Notifications] ℹ️ Skip login - no scale configured for employee ${employeeId}`);
        return res.status(200).json({
            success: true,
            message: 'No scale configured - notification not sent',
            isSynced: false,
            sent: 0
        });
    }

    try {
        console.log(`[Notifications] 📤 Processing event: ${eventType} for employee ${employeeId}`);

        // Obtener dispositivos activos del empleado
        const result = await pool.query(
            `SELECT id, device_token FROM device_tokens
             WHERE employee_id = $1 AND is_active = true`,
            [employeeId]
        );

        const deviceTokens = result.rows.map(row => row.device_token);

        if (deviceTokens.length === 0) {
            console.log(`[Notifications] ℹ️ No active devices for employee ${employeeId}`);
            return res.status(200).json({
                success: true,
                message: 'No active devices found',
                isSynced: false,
                sent: 0
            });
        }

        // Construir título y body según el tipo de evento
        let notificationTitle = '';
        let notificationBody = '';

        switch (eventType) {
            case 'shift-opened':
                const scaleText = scaleStatus === 'connected' ? 'conectada' : 'desconectada';
                const initialAmount = data.initialAmount || 0;
                notificationTitle = '💰 Turno Abierto';
                notificationBody = `${userName} abrió turno con $${initialAmount.toFixed(2)} (báscula ${scaleText})`;
                break;

            case 'login':
                // LEGACY - Se mantiene para compatibilidad, pero ya no se usa
                const scaleTextLogin = scaleStatus === 'connected' ? 'conectada' : 'desconectada';
                notificationTitle = 'Nuevo Acceso';
                notificationBody = `${userName} inició sesión (báscula ${scaleTextLogin})`;
                break;

            case 'cash-cut-created':
                notificationTitle = 'Cierre de Caja Iniciado';
                notificationBody = `${userName} inició un cierre de caja`;
                break;

            case 'cash-cut-closed':
                notificationTitle = 'Cierre de Caja Completado';
                notificationBody = `${userName} completó el cierre de caja`;
                break;

            default:
                notificationTitle = 'Notificación';
                notificationBody = `Evento: ${eventType}`;
        }

        // Intentar enviar notificaciones FCM
        let successCount = 0;
        let failureCount = 0;
        const invalidTokens = [];

        const notificationData = {
            eventType: eventType,
            eventTime: eventTime, // Usar timestamp del cliente
            userName: userName,
            scaleStatus: scaleStatus || 'none',
            isSynced: 'true',
            ...data
        };

        // Intentar enviar a cada dispositivo
        for (const token of deviceTokens) {
            try {
                const sendResult = await sendNotificationToDevice(token, {
                    title: notificationTitle,
                    body: notificationBody,
                    data: notificationData
                });

                if (sendResult.success) {
                    successCount++;
                } else {
                    failureCount++;
                    if (sendResult.result === 'INVALID_TOKEN') {
                        invalidTokens.push(token);
                    }
                }
            } catch (err) {
                console.error(`[Notifications] ❌ Error sending to token: ${err.message}`);
                failureCount++;
            }
        }

        // Deactivar tokens inválidos
        if (invalidTokens.length > 0) {
            await pool.query(
                `UPDATE device_tokens SET is_active = false
                 WHERE device_token = ANY($1)`,
                [invalidTokens]
            );
            console.log(`[Notifications] 🧹 Deactivated ${invalidTokens.length} invalid tokens`);
        }

        console.log(`[Notifications] ✅ Event ${eventType} sent: ${successCount}/${deviceTokens.length}`);

        res.status(200).json({
            success: true,
            message: 'Notification sent successfully',
            eventType: eventType,
            eventTime: eventTime,
            sent: successCount,
            failed: failureCount,
            isSynced: true
        });

    } catch (error) {
        console.error('[Notifications] ❌ Error in send-event:', error.message);
        res.status(500).json({
            success: false,
            message: 'Failed to send notification',
            error: error.message,
            isSynced: false
        });
    }
});

module.exports = router;
