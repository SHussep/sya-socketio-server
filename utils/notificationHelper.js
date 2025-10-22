// ═══════════════════════════════════════════════════════════════
// NOTIFICATION HELPER
// Envía notificaciones FCM basadas en eventos del backend
// ═══════════════════════════════════════════════════════════════

const axios = require('axios');
const { sendNotificationToMultipleDevices } = require('./firebaseAdmin');
const { pool } = require('../database');

/**
 * Envía notificación a todos los repartidores de una sucursal
 */
async function sendNotificationToBranch(branchId, { title, body, data = {} }) {
    try {
        // Obtener todos los dispositivos activos de la sucursal
        const result = await pool.query(
            `SELECT DISTINCT device_token FROM device_tokens
             WHERE branch_id = $1 AND is_active = true`,
            [branchId]
        );

        const deviceTokens = result.rows.map(row => row.device_token);

        if (deviceTokens.length === 0) {
            console.log(`[NotificationHelper] ℹ️ No hay dispositivos activos en la sucursal ${branchId}`);
            return { sent: 0, failed: 0 };
        }

        const results = await sendNotificationToMultipleDevices(deviceTokens, {
            title,
            body,
            data
        });

        const successCount = results.filter(r => r.success).length;
        console.log(`[NotificationHelper] ✅ Notificaciones enviadas a sucursal ${branchId}: ${successCount}/${deviceTokens.length}`);

        return {
            sent: successCount,
            failed: deviceTokens.length - successCount,
            total: deviceTokens.length
        };
    } catch (error) {
        console.error('[NotificationHelper] ❌ Error enviando notificaciones:', error.message);
        return { sent: 0, failed: 0, error: error.message };
    }
}

/**
 * Envía notificación cuando un usuario inicia sesión
 */
async function notifyUserLogin(branchId, { employeeName, branchName, scaleStatus }) {
    return await sendNotificationToBranch(branchId, {
        title: '👤 Acceso de Usuario',
        body: `${employeeName} inició sesión en ${branchName}`,
        data: {
            type: 'user_login',
            employeeName,
            branchName,
            scaleStatus
        }
    });
}

/**
 * Envía notificación cuando hay una alerta de báscula
 */
async function notifyScaleAlert(branchId, { severity, eventType, details, employeeName }) {
    const icon = severity === 'high' ? '🔴' : severity === 'medium' ? '🟡' : '🟢';

    return await sendNotificationToBranch(branchId, {
        title: `${icon} Alerta de Báscula`,
        body: `${eventType}: ${details} (${employeeName})`,
        data: {
            type: 'scale_alert',
            severity,
            eventType,
            employeeName
        }
    });
}

/**
 * Envía notificación cuando se completa una venta
 */
async function notifySaleCompleted(branchId, { ticketNumber, total, paymentMethod, employeeName }) {
    return await sendNotificationToBranch(branchId, {
        title: '💰 Venta Completada',
        body: `Ticket #${ticketNumber} - $${total.toFixed(2)} (${paymentMethod})`,
        data: {
            type: 'sale_completed',
            ticketNumber: ticketNumber.toString(),
            total: total.toString(),
            paymentMethod,
            employeeName
        }
    });
}

/**
 * Envía notificación cuando se inicia un turno
 */
async function notifyShiftStarted(branchId, { employeeName, branchName, initialAmount, startTime }) {
    return await sendNotificationToBranch(branchId, {
        title: '🟢 Turno Iniciado',
        body: `${employeeName} inició turno en ${branchName} con $${initialAmount.toFixed(2)}`,
        data: {
            type: 'shift_started',
            employeeName,
            branchName,
            initialAmount: initialAmount.toString()
        }
    });
}

/**
 * Envía notificación cuando termina un turno
 */
async function notifyShiftEnded(branchId, { employeeName, branchName, difference, countedCash, expectedCash }) {
    const icon = difference >= 0 ? '💰' : '⚠️';
    const status = difference === 0
        ? 'Sin diferencia'
        : difference > 0
            ? `Sobrante: $${difference.toFixed(2)}`
            : `Faltante: $${Math.abs(difference).toFixed(2)}`;

    return await sendNotificationToBranch(branchId, {
        title: `${icon} Corte de Caja`,
        body: `${employeeName} finalizó turno en ${branchName} - ${status}`,
        data: {
            type: 'shift_ended',
            employeeName,
            branchName,
            difference: difference.toString(),
            status
        }
    });
}

/**
 * Envía notificación cuando la báscula se desconecta
 */
async function notifyScaleDisconnection(branchId, { message }) {
    return await sendNotificationToBranch(branchId, {
        title: '❌ Báscula Desconectada',
        body: message || 'La báscula se ha desconectado',
        data: {
            type: 'scale_disconnected'
        }
    });
}

/**
 * Envía notificación cuando la báscula se conecta
 */
async function notifyScaleConnection(branchId, { message }) {
    return await sendNotificationToBranch(branchId, {
        title: '✅ Báscula Conectada',
        body: message || 'La báscula se ha conectado',
        data: {
            type: 'scale_connected'
        }
    });
}

module.exports = {
    sendNotificationToBranch,
    notifyUserLogin,
    notifyScaleAlert,
    notifySaleCompleted,
    notifyShiftStarted,
    notifyShiftEnded,
    notifyScaleDisconnection,
    notifyScaleConnection
};
