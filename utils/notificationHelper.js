// ═══════════════════════════════════════════════════════════════
// NOTIFICATION HELPER
// Envía notificaciones FCM basadas en eventos del backend
// ═══════════════════════════════════════════════════════════════

const axios = require('axios');
const { sendNotificationToMultipleDevices } = require('./firebaseAdmin');
const { pool } = require('../database');

/**
 * Envía notificación a todos los dispositivos de una sucursal
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
        const invalidTokens = results
            .filter(r => r.result === 'INVALID_TOKEN')
            .map(r => r.deviceToken);

        console.log(`[NotificationHelper] ✅ Notificaciones enviadas a sucursal ${branchId}: ${successCount}/${deviceTokens.length}`);

        // Desactivar tokens inválidos
        if (invalidTokens.length > 0) {
            try {
                await pool.query(
                    `UPDATE device_tokens SET is_active = false
                     WHERE device_token = ANY($1)`,
                    [invalidTokens]
                );
                console.log(`[NotificationHelper] 🧹 Deactivated ${invalidTokens.length} invalid tokens from branch ${branchId}`);
            } catch (updateError) {
                console.error(`[NotificationHelper] ⚠️ Error updating invalid tokens:`, updateError.message);
            }
        }

        return {
            sent: successCount,
            failed: deviceTokens.length - successCount,
            total: deviceTokens.length,
            invalidTokensRemoved: invalidTokens.length
        };
    } catch (error) {
        console.error('[NotificationHelper] ❌ Error enviando notificaciones:', error.message);
        return { sent: 0, failed: 0, error: error.message };
    }
}

/**
 * Envía notificación SOLO a administradores y encargados de una sucursal
 * Útil para eventos que solo los supervisores deben ver (login, alertas, etc.)
 */
async function sendNotificationToAdminsInBranch(branchId, { title, body, data = {} }) {
    try {
        // Obtener dispositivos de empleados con role_id 1 (Administrador) o 2 (Encargado)
        const result = await pool.query(
            `SELECT DISTINCT dt.device_token
             FROM device_tokens dt
             JOIN employees e ON dt.employee_id = e.id
             WHERE dt.branch_id = $1
               AND dt.is_active = true
               AND e.role_id IN (1, 2)`,
            [branchId]
        );

        const deviceTokens = result.rows.map(row => row.device_token);

        if (deviceTokens.length === 0) {
            console.log(`[NotificationHelper] ℹ️ No hay administradores/encargados con dispositivos activos en sucursal ${branchId}`);
            return { sent: 0, failed: 0 };
        }

        const results = await sendNotificationToMultipleDevices(deviceTokens, {
            title,
            body,
            data
        });

        const successCount = results.filter(r => r.success).length;
        const invalidTokens = results
            .filter(r => r.result === 'INVALID_TOKEN')
            .map(r => r.deviceToken);

        console.log(`[NotificationHelper] ✅ Notificaciones enviadas a admins/encargados de sucursal ${branchId}: ${successCount}/${deviceTokens.length}`);

        // Desactivar tokens inválidos
        if (invalidTokens.length > 0) {
            try {
                await pool.query(
                    `UPDATE device_tokens SET is_active = false
                     WHERE device_token = ANY($1)`,
                    [invalidTokens]
                );
                console.log(`[NotificationHelper] 🧹 Deactivated ${invalidTokens.length} invalid tokens from branch ${branchId}`);
            } catch (updateError) {
                console.error(`[NotificationHelper] ⚠️ Error updating invalid tokens:`, updateError.message);
            }
        }

        return {
            sent: successCount,
            failed: deviceTokens.length - successCount,
            total: deviceTokens.length,
            invalidTokensRemoved: invalidTokens.length
        };
    } catch (error) {
        console.error('[NotificationHelper] ❌ Error enviando notificaciones a admins:', error.message);
        return { sent: 0, failed: 0, error: error.message };
    }
}

/**
 * Envía notificación a un empleado específico
 * @param {string} employeeId - GlobalId (UUID) del empleado para idempotencia
 */
async function sendNotificationToEmployee(employeeId, { title, body, data = {} }) {
    try {
        // IMPORTANTE: employeeId es el GlobalId (UUID), no el autoincrement ID
        // Obtener el ID numérico del empleado desde PostgreSQL usando global_id
        const employeeResult = await pool.query(
            `SELECT id FROM employees WHERE global_id = $1 LIMIT 1`,
            [employeeId]
        );

        if (employeeResult.rows.length === 0) {
            console.log(`[NotificationHelper] ⚠️ No se encontró empleado con global_id: ${employeeId}`);
            return { sent: 0, failed: 0 };
        }

        const employeeIdNumeric = employeeResult.rows[0].id;

        // Obtener todos los dispositivos activos del empleado
        const result = await pool.query(
            `SELECT DISTINCT device_token FROM device_tokens
             WHERE employee_id = $1 AND is_active = true`,
            [employeeIdNumeric]
        );

        const deviceTokens = result.rows.map(row => row.device_token);

        if (deviceTokens.length === 0) {
            console.log(`[NotificationHelper] ℹ️ No hay dispositivos activos para employee ${employeeId}`);
            return { sent: 0, failed: 0 };
        }

        const results = await sendNotificationToMultipleDevices(deviceTokens, {
            title,
            body,
            data
        });

        const successCount = results.filter(r => r.success).length;
        const invalidTokens = results
            .filter(r => r.result === 'INVALID_TOKEN')
            .map(r => r.deviceToken);

        console.log(`[NotificationHelper] ✅ Notificaciones enviadas a employee ${employeeIdNumeric} (global_id: ${employeeId}): ${successCount}/${deviceTokens.length}`);

        // Desactivar tokens inválidos
        if (invalidTokens.length > 0) {
            try {
                await pool.query(
                    `UPDATE device_tokens SET is_active = false
                     WHERE device_token = ANY($1)`,
                    [invalidTokens]
                );
                console.log(`[NotificationHelper] 🧹 Deactivated ${invalidTokens.length} invalid tokens from employee ${employeeId}`);
            } catch (updateError) {
                console.error(`[NotificationHelper] ⚠️ Error updating invalid tokens:`, updateError.message);
            }
        }

        return {
            sent: successCount,
            failed: deviceTokens.length - successCount,
            total: deviceTokens.length,
            invalidTokensRemoved: invalidTokens.length
        };
    } catch (error) {
        console.error('[NotificationHelper] ❌ Error enviando notificaciones:', error.message);
        return { sent: 0, failed: 0, error: error.message };
    }
}

/**
 * Envía notificación cuando un usuario inicia sesión
 * A: Administradores y encargados (role_id 1,2) EXCEPTO el que hizo login + el empleado que hizo login
 */
async function notifyUserLogin(branchId, { employeeId, employeeName, branchName, scaleStatus }) {
    try {
        // IMPORTANTE: employeeId es el GlobalId (UUID), no el autoincrement ID
        // Obtener el ID numérico del empleado desde PostgreSQL usando global_id
        const employeeResult = await pool.query(
            `SELECT id, role_id FROM employees WHERE global_id = $1 LIMIT 1`,
            [employeeId]
        );

        if (employeeResult.rows.length === 0) {
            console.log(`[NotificationHelper] ⚠️ No se encontró empleado con global_id: ${employeeId}`);
            return { sent: 0, failed: 0 };
        }

        const employeeIdNumeric = employeeResult.rows[0].id;
        const employeeRoleId = employeeResult.rows[0].role_id;

        // Enviar notificación personalizada al empleado que hizo login
        const selfResult = await sendNotificationToEmployee(employeeId, {
            title: '👤 Acceso de Usuario',
            body: `Iniciaste sesión en ${branchName}`,
            data: {
                type: 'user_login',
                employeeName,
                branchName,
                scaleStatus
            }
        });

        // Solo enviar a otros admins/encargados si no es el mismo empleado
        // Obtener dispositivos de empleados con role_id 1 (Administrador) o 2 (Encargado)
        // EXCLUYENDO al empleado que hizo login
        const adminTokensResult = await pool.query(
            `SELECT DISTINCT dt.device_token
             FROM device_tokens dt
             JOIN employees e ON dt.employee_id = e.id
             WHERE dt.branch_id = $1
               AND dt.is_active = true
               AND e.role_id IN (1, 2)
               AND e.id != $2`,
            [branchId, employeeIdNumeric]
        );

        const adminDeviceTokens = adminTokensResult.rows.map(row => row.device_token);

        let adminResult = { sent: 0, failed: 0, total: 0 };

        if (adminDeviceTokens.length > 0) {
            const results = await sendNotificationToMultipleDevices(adminDeviceTokens, {
                title: '👤 Acceso de Usuario',
                body: `${employeeName} inició sesión en ${branchName}`,
                data: {
                    type: 'user_login',
                    employeeName,
                    branchName,
                    scaleStatus
                }
            });

            const successCount = results.filter(r => r.success).length;
            const invalidTokens = results
                .filter(r => r.result === 'INVALID_TOKEN')
                .map(r => r.deviceToken);

            console.log(`[NotificationHelper] ✅ Notificaciones enviadas a otros admins/encargados de sucursal ${branchId}: ${successCount}/${adminDeviceTokens.length}`);

            // Desactivar tokens inválidos
            if (invalidTokens.length > 0) {
                await pool.query(
                    `UPDATE device_tokens SET is_active = false WHERE device_token = ANY($1)`,
                    [invalidTokens]
                );
                console.log(`[NotificationHelper] 🧹 Deactivated ${invalidTokens.length} invalid tokens`);
            }

            adminResult = {
                sent: successCount,
                failed: adminDeviceTokens.length - successCount,
                total: adminDeviceTokens.length,
                invalidTokensRemoved: invalidTokens.length
            };
        } else {
            console.log(`[NotificationHelper] ℹ️ No hay otros admins/encargados en sucursal ${branchId}`);
        }

        return {
            self: selfResult,
            others: adminResult,
            total: selfResult.sent + adminResult.sent
        };
    } catch (error) {
        console.error('[NotificationHelper] ❌ Error en notifyUserLogin:', error.message);
        return { sent: 0, failed: 0, error: error.message };
    }
}

/**
 * Envía notificación cuando un usuario cierra sesión
 * A: Administradores y encargados (role_id 1,2) EXCEPTO el que hizo logout + el empleado que hizo logout
 */
async function notifyUserLogout(branchId, { employeeId, employeeName, branchName }) {
    try {
        // IMPORTANTE: employeeId es el GlobalId (UUID), no el autoincrement ID
        // Obtener el ID numérico del empleado desde PostgreSQL usando global_id
        const employeeResult = await pool.query(
            `SELECT id, role_id FROM employees WHERE global_id = $1 LIMIT 1`,
            [employeeId]
        );

        if (employeeResult.rows.length === 0) {
            console.log(`[NotificationHelper] ⚠️ No se encontró empleado con global_id: ${employeeId}`);
            return { sent: 0, failed: 0 };
        }

        const employeeIdNumeric = employeeResult.rows[0].id;
        const employeeRoleId = employeeResult.rows[0].role_id;

        // Enviar notificación personalizada al empleado que hizo logout
        const selfResult = await sendNotificationToEmployee(employeeId, {
            title: '👋 Sesión Cerrada',
            body: `Cerraste sesión en ${branchName}`,
            data: {
                type: 'user_logout',
                employeeName,
                branchName
            }
        });

        // Solo enviar a otros admins/encargados si no es el mismo empleado
        // Obtener dispositivos de empleados con role_id 1 (Administrador) o 2 (Encargado)
        // EXCLUYENDO al empleado que hizo logout
        const adminTokensResult = await pool.query(
            `SELECT DISTINCT dt.device_token
             FROM device_tokens dt
             JOIN employees e ON dt.employee_id = e.id
             WHERE dt.branch_id = $1
               AND dt.is_active = true
               AND e.role_id IN (1, 2)
               AND e.id != $2`,
            [branchId, employeeIdNumeric]
        );

        const adminDeviceTokens = adminTokensResult.rows.map(row => row.device_token);

        let adminResult = { sent: 0, failed: 0, total: 0 };

        if (adminDeviceTokens.length > 0) {
            const results = await sendNotificationToMultipleDevices(adminDeviceTokens, {
                title: '👋 Usuario Desconectado',
                body: `${employeeName} cerró sesión en ${branchName}`,
                data: {
                    type: 'user_logout',
                    employeeName,
                    branchName
                }
            });

            const successCount = results.filter(r => r.success).length;
            const invalidTokens = results
                .filter(r => r.result === 'INVALID_TOKEN')
                .map(r => r.deviceToken);

            console.log(`[NotificationHelper] ✅ Notificaciones de logout enviadas a otros admins/encargados de sucursal ${branchId}: ${successCount}/${adminDeviceTokens.length}`);

            // Desactivar tokens inválidos
            if (invalidTokens.length > 0) {
                await pool.query(
                    `UPDATE device_tokens SET is_active = false WHERE device_token = ANY($1)`,
                    [invalidTokens]
                );
                console.log(`[NotificationHelper] 🧹 Deactivated ${invalidTokens.length} invalid tokens`);
            }

            adminResult = {
                sent: successCount,
                failed: adminDeviceTokens.length - successCount,
                total: adminDeviceTokens.length,
                invalidTokensRemoved: invalidTokens.length
            };
        } else {
            console.log(`[NotificationHelper] ℹ️ No hay otros admins/encargados en sucursal ${branchId}`);
        }

        return {
            self: selfResult,
            others: adminResult,
            total: selfResult.sent + adminResult.sent
        };
    } catch (error) {
        console.error('[NotificationHelper] ❌ Error en notifyUserLogout:', error.message);
        return { sent: 0, failed: 0, error: error.message };
    }
}

/**
 * Envía notificación cuando hay una alerta de báscula
 * Solo notifica a administradores y encargados (role_id 1, 2)
 */
async function notifyScaleAlert(branchId, { severity, eventType, details, employeeName }) {
    const icon = severity === 'high' ? '🔴' : severity === 'medium' ? '🟡' : '🟢';

    return await sendNotificationToAdminsInBranch(branchId, {
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
 * Solo notifica a administradores y encargados (role_id 1, 2)
 */
async function notifyShiftStarted(branchId, { employeeName, branchName, initialAmount, startTime }) {
    return await sendNotificationToAdminsInBranch(branchId, {
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

/**
 * Envía notificación cuando se crea una asignación para un repartidor
 * Notifica a:
 * 1. El repartidor que recibe la asignación
 * 2. Los administradores y encargados de la sucursal
 * @param {string} employeeGlobalId - GlobalId (UUID) del repartidor
 * @param {number} branchId - ID de la sucursal
 * @param {string} employeeName - Nombre del repartidor
 * @param {string} createdByName - Nombre del empleado que autorizó la asignación
 */
async function notifyAssignmentCreated(employeeGlobalId, { assignmentId, quantity, amount, branchName, branchId, employeeName, createdByName }) {
    // Notificar al repartidor (usando GlobalId)
    const employeeResult = await sendNotificationToEmployee(employeeGlobalId, {
        title: '📦 Nueva Asignación',
        body: `Se te asignó ${quantity.toFixed(2)} kg ($${amount.toFixed(2)}) en ${branchName}`,
        data: {
            type: 'assignment_created',
            assignmentId: assignmentId.toString(),
            quantity: quantity.toString(),
            amount: amount.toString(),
            branchName
        }
    });

    // Notificar a administradores y encargados
    const adminResult = await sendNotificationToAdminsInBranch(branchId, {
        title: '📦 Asignación Creada',
        body: `${employeeName} recibió ${quantity.toFixed(2)} kg ($${amount.toFixed(2)}) autorizado por ${createdByName}`,
        data: {
            type: 'assignment_created',
            assignmentId: assignmentId.toString(),
            employeeName,
            createdByName,
            quantity: quantity.toString(),
            amount: amount.toString(),
            branchName
        }
    });

    return {
        employee: employeeResult,
        admins: adminResult,
        total: employeeResult.sent + adminResult.sent
    };
}

module.exports = {
    sendNotificationToBranch,
    sendNotificationToAdminsInBranch,
    sendNotificationToEmployee,
    notifyUserLogin,
    notifyUserLogout,
    notifyScaleAlert,
    notifySaleCompleted,
    notifyShiftStarted,
    notifyShiftEnded,
    notifyScaleDisconnection,
    notifyScaleConnection,
    notifyAssignmentCreated
};
