/**
 * jobs/expireBackupRequests.js
 *
 * Task 29 — Fase 6: Expiración de backup requests vencidos.
 *
 * Marca como 'expired' las solicitudes de backup que superaron su TTL (48h)
 * y elimina el blob del storage si ya fue uploaded.
 *
 * Se ejecuta cada hora via setInterval en server.js.
 */

const { pool } = require('../database');
const storage = require('../services/backupStorage');

async function expireBackupRequests() {
    const expired = await pool.query(
        `SELECT id, storage_key FROM sync_backup_requests
         WHERE status IN ('pending', 'uploaded')
           AND expires_at < NOW()`
    );

    if (expired.rowCount === 0) return 0;

    let cleaned = 0;
    for (const row of expired.rows) {
        // Eliminar blob del storage si fue uploaded
        if (row.storage_key) {
            try {
                await storage.deleteObject(row.storage_key);
            } catch (e) {
                console.error(`[ExpireBackup] Error deleting blob ${row.storage_key}:`, e.message);
            }
        }

        await pool.query(
            `UPDATE sync_backup_requests SET status = 'expired' WHERE id = $1`,
            [row.id]
        );
        cleaned++;
    }

    if (cleaned > 0) {
        console.log(`[ExpireBackup] Expired ${cleaned} backup request(s)`);
    }

    return cleaned;
}

module.exports = { expireBackupRequests };
