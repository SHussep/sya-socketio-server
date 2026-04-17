/**
 * jobs/cleanupSyncDiagnostics.js
 *
 * Task 28 — Fase 6: Limpieza periódica de tablas de diagnóstico de sync.
 *
 * Retención:
 *   - sync_census_reports:         90 días
 *   - sync_admin_command_log:     180 días
 *   - sync_quarantine_reports:    365 días (solo con admin_decided_at)
 *   - super_admin_jwt_revocations: 90 días
 *
 * Se ejecuta cada 24 horas via setInterval en server.js.
 */

const { pool } = require('../database');

async function cleanupSyncDiagnostics() {
    let totalDeleted = 0;

    // Census reports — 90 días
    const census = await pool.query(
        `DELETE FROM sync_census_reports WHERE received_at < NOW() - INTERVAL '90 days'`
    );
    totalDeleted += census.rowCount;

    // Admin command log — 180 días
    const commands = await pool.query(
        `DELETE FROM sync_admin_command_log WHERE issued_at < NOW() - INTERVAL '180 days'`
    );
    totalDeleted += commands.rowCount;

    // Quarantine reports — 365 días (solo decididas por admin)
    const quarantine = await pool.query(
        `DELETE FROM sync_quarantine_reports
         WHERE admin_decided_at IS NOT NULL
           AND admin_decided_at < NOW() - INTERVAL '365 days'`
    );
    totalDeleted += quarantine.rowCount;

    // JWT revocations — 90 días
    const revocations = await pool.query(
        `DELETE FROM super_admin_jwt_revocations WHERE revoked_at < NOW() - INTERVAL '90 days'`
    );
    totalDeleted += revocations.rowCount;

    if (totalDeleted > 0) {
        console.log(
            `[SyncDiagCleanup] Purged ${totalDeleted} rows ` +
            `(census:${census.rowCount}, commands:${commands.rowCount}, ` +
            `quarantine:${quarantine.rowCount}, revocations:${revocations.rowCount})`
        );
    }

    return totalDeleted;
}

module.exports = { cleanupSyncDiagnostics };
