// ═══════════════════════════════════════════════════════════════
// SUPERADMIN NOTIFIER
// Envía notificaciones FCM a todos los dispositivos SuperAdmin
// (SYAAdmin app) que estén activos en la tabla superadmin_devices.
// ═══════════════════════════════════════════════════════════════

const { pool } = require('../database');
const {
    sendNotificationToMultipleDevices,
    isFirebaseInitialized,
} = require('./firebaseAdmin');

/**
 * Envía una notificación FCM a todos los SuperAdmins con dispositivo activo.
 * @param {string} title  Título visible.
 * @param {string} body   Cuerpo visible.
 * @param {object} [data] Payload extra (strings only para FCM).
 * @returns {Promise<{sent:number, failed:number, total:number}>}
 */
async function notifySuperadmins(title, body, data = {}) {
    if (!isFirebaseInitialized()) {
        console.warn('[SuperadminNotifier] Firebase no inicializado, skip');
        return { sent: 0, failed: 0, total: 0 };
    }

    let tokens = [];
    try {
        const result = await pool.query(
            `SELECT device_token FROM superadmin_devices WHERE is_active = TRUE`
        );
        tokens = result.rows.map((r) => r.device_token);
    } catch (err) {
        console.error('[SuperadminNotifier] Error leyendo tokens:', err.message);
        return { sent: 0, failed: 0, total: 0 };
    }

    if (tokens.length === 0) {
        return { sent: 0, failed: 0, total: 0 };
    }

    // FCM data payload: todos los valores deben ser strings
    const stringData = {};
    for (const [k, v] of Object.entries(data)) {
        stringData[k] = v == null ? '' : String(v);
    }

    const results = await sendNotificationToMultipleDevices(tokens, {
        title,
        body,
        data: stringData,
    });

    const sent = results.filter((r) => r.success).length;
    const failed = results.length - sent;

    // Limpiar tokens inválidos
    const invalidTokens = results
        .filter((r) => r.result === 'INVALID_TOKEN')
        .map((r) => r.deviceToken);

    if (invalidTokens.length > 0) {
        try {
            await pool.query(
                `UPDATE superadmin_devices SET is_active = FALSE, updated_at = NOW()
                 WHERE device_token = ANY($1)`,
                [invalidTokens]
            );
            console.log(
                `[SuperadminNotifier] Desactivados ${invalidTokens.length} tokens inválidos`
            );
        } catch (err) {
            console.error('[SuperadminNotifier] Error limpiando tokens:', err.message);
        }
    }

    console.log(
        `[SuperadminNotifier] ${sent}/${tokens.length} enviadas — "${title}"`
    );

    return { sent, failed, total: tokens.length };
}

module.exports = { notifySuperadmins };
