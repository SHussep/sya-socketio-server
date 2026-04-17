/**
 * utils/adminCommandJwt.js
 *
 * Helper compartido para emitir JWTs RS256 de corta duración (≤5 min) que
 * autorizan comandos administrativos remotos enviados al desktop (Fase 4
 * remote repair).
 *
 * El desktop (SyncRepairCommandListener) valida estos tokens con la parte
 * pública de la llave super-admin embebida en el binario:
 *   - Firma RS256 válida (F1)
 *   - authorizedTenants incluye el tenant del desktop (F2)
 *   - jti / commandId único contra replay (F3)
 *   - exp ≤ ahora + 5 min (F4)
 *
 * La firma se hace con la MISMA llave privada que usa
 * `/api/auth/super-admin/login` (Task 4), cargada desde
 * `SUPER_ADMIN_PRIVATE_KEY_PATH` y cacheada por el proceso.
 */

const fs = require('fs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

let ADMIN_CMD_PRIVATE_KEY = null;

function loadAdminCommandPrivateKey() {
    if (ADMIN_CMD_PRIVATE_KEY) return ADMIN_CMD_PRIVATE_KEY;
    const p = process.env.SUPER_ADMIN_PRIVATE_KEY_PATH;
    if (!p) throw new Error('SUPER_ADMIN_PRIVATE_KEY_PATH not set');
    ADMIN_CMD_PRIVATE_KEY = fs.readFileSync(p, 'utf8');
    return ADMIN_CMD_PRIVATE_KEY;
}

/**
 * Construye un JWT RS256 audience-bound para un comando admin.
 * @param {number} tenantId - Tenant autorizado (único permitido).
 * @param {number|string} userId - admin_user_id original que emitió el comando.
 * @param {number} [ttlMinutes=5] - TTL en minutos, forzado al rango [1,5].
 * @returns {string} JWT firmado.
 */
function buildAdminCommandJwt(tenantId, userId, ttlMinutes = 5) {
    const ttl = Math.max(1, Math.min(5, Number(ttlMinutes) || 5));
    return jwt.sign(
        {
            sub: String(userId),
            role: 'super_admin',
            authorizedTenants: [tenantId],
            jti: crypto.randomUUID()
        },
        loadAdminCommandPrivateKey(),
        {
            algorithm: 'RS256',
            expiresIn: `${ttl}m`,
            audience: 'sync-diagnostics-admin'
        }
    );
}

module.exports = { buildAdminCommandJwt, loadAdminCommandPrivateKey };
