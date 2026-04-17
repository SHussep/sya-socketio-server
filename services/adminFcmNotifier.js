/**
 * services/adminFcmNotifier.js
 *
 * Task 30 — Fase 6: Notificación FCM a admins cuando se reporta una cuarentena.
 *
 * Envía push FCM al owner/admin del tenant cuando un dispositivo cuarentena
 * una entidad. Throttle: máximo 1 push por device por hora para evitar spam.
 *
 * Usa la infraestructura existente de firebaseAdmin.js.
 */

const { pool } = require('../database');
const { sendNotificationToDevice } = require('../utils/firebaseAdmin');

// In-memory throttle: { `${tenantId}:${deviceId}` → lastNotifiedAt }
const throttleMap = new Map();
const THROTTLE_MS = 60 * 60 * 1000; // 1 hora

/**
 * Notifica a los admins/owners del tenant que un dispositivo cuarentenó una entidad.
 *
 * @param {Object} report - Quarantine report payload
 * @param {number} report.tenantId
 * @param {number} report.branchId
 * @param {string} report.deviceId
 * @param {string} [report.deviceName]
 * @param {Object} report.entity - { type, globalId }
 */
async function notifyAdminsOfNewQuarantine(report) {
    if (!report?.tenantId || !report?.entity) return;

    // Throttle check — 1 push por device por hora
    const throttleKey = `${report.tenantId}:${report.deviceId}`;
    const lastNotified = throttleMap.get(throttleKey);
    if (lastNotified && (Date.now() - lastNotified) < THROTTLE_MS) {
        return; // ya notificamos recientemente para este device
    }

    try {
        // Buscar tokens FCM de owners/admins del tenant (role_id = 1 o is_owner = true)
        const result = await pool.query(
            `SELECT DISTINCT dt.device_token, e.first_name
             FROM employees e
             JOIN device_tokens dt ON dt.employee_id = e.id
             WHERE e.tenant_id = $1
               AND (e.is_owner = true OR e.role_id = 1)
               AND e.is_active = true
               AND dt.is_active = true`,
            [report.tenantId]
        );

        if (result.rowCount === 0) return;

        const deviceName = report.deviceName || report.deviceId;
        const entityType = report.entity.type || 'desconocido';

        for (const row of result.rows) {
            try {
                const pushResult = await sendNotificationToDevice(row.device_token, {
                    title: 'Sync: Entidad en cuarentena',
                    body: `${deviceName} — ${entityType}`,
                    data: {
                        type: 'quarantine_new',
                        deviceId: report.deviceId || '',
                        deviceName: deviceName,
                        entityType: entityType,
                        globalId: report.entity.globalId || ''
                    }
                });

                // Si el token es inválido, desactivarlo
                if (pushResult === 'INVALID_TOKEN') {
                    await pool.query(
                        `UPDATE device_tokens SET is_active = false WHERE device_token = $1`,
                        [row.device_token]
                    );
                }
            } catch (e) {
                console.error(`[AdminFCM] Error sending to ${row.first_name}:`, e.message);
            }
        }

        // Actualizar throttle
        throttleMap.set(throttleKey, Date.now());

        // Limpiar entradas viejas del throttle map cada cierto tiempo
        if (throttleMap.size > 1000) {
            const cutoff = Date.now() - THROTTLE_MS;
            for (const [key, ts] of throttleMap) {
                if (ts < cutoff) throttleMap.delete(key);
            }
        }
    } catch (e) {
        console.error('[AdminFCM] notifyAdminsOfNewQuarantine error:', e.message);
    }
}

module.exports = { notifyAdminsOfNewQuarantine };
