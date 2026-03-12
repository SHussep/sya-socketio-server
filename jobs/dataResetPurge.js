// ═══════════════════════════════════════════════════════════════
// DATA RESET PURGE JOB
// Elimina datos transaccionales de PostgreSQL para branches
// que fueron reseteadas hace más de 30 días
// ═══════════════════════════════════════════════════════════════

const { pool } = require('../database');

// Tablas transaccionales a purgar (orden por dependencias FK)
const TRANSACTIONAL_TABLES_ORDERED = [
    // Primero las que tienen FK a otras transaccionales
    { table: 'ventas_detalle', fk: 'id_venta', parent: 'ventas', branchCol: null },
    { table: 'notas_credito_detalle', fk: 'nota_credito_id', parent: 'notas_credito', branchCol: null },
    { table: 'purchase_details', fk: 'purchase_id', parent: 'purchases', branchCol: null },
    { table: 'inventory_transfer_items', fk: 'transfer_id', parent: 'inventory_transfers', branchCol: null },
    { table: 'repartidor_shift_cash_snapshot', branchCol: 'branch_id' },
    { table: 'shift_cash_snapshot', branchCol: 'branch_id' },
    // Luego las principales
    { table: 'ventas', branchCol: 'branch_id' },
    { table: 'notas_credito', branchCol: 'branch_id' },
    { table: 'expenses', branchCol: 'branch_id' },
    { table: 'cash_cuts', branchCol: 'branch_id' },
    { table: 'deposits', branchCol: 'branch_id' },
    { table: 'withdrawals', branchCol: 'branch_id' },
    { table: 'shifts', branchCol: 'branch_id' },
    { table: 'credit_payments', branchCol: 'branch_id' },
    { table: 'purchases', branchCol: 'branch_id' },
    { table: 'repartidor_assignments', branchCol: 'branch_id' },
    { table: 'repartidor_returns', branchCol: 'branch_id' },
    { table: 'repartidor_debts', branchCol: 'branch_id' },
    { table: 'employee_debts', branchCol: 'branch_id' },
    { table: 'preparation_mode_logs', branchCol: 'branch_id' },
    { table: 'suspicious_weighing_logs', branchCol: 'branch_id' },
    { table: 'scale_disconnection_logs', branchCol: 'branch_id' },
    { table: 'cancelaciones_bitacora', branchCol: 'branch_id' },
    { table: 'repartidor_locations', branchCol: 'branch_id' },
    { table: 'gps_consent_log', branchCol: 'branch_id' },
    { table: 'geofence_events', branchCol: 'branch_id' },
    { table: 'employee_daily_metrics', branchCol: 'branch_id' },
    { table: 'inventory_transfers', branchCol: 'source_branch_id' },
    { table: 'guardian_employee_scores_daily', branchCol: 'branch_id' },
    { table: 'suspicious_weighing_events', branchCol: 'branch_id' },
    { table: 'scale_disconnections', branchCol: 'branch_id' },
    { table: 'sessions', branchCol: 'branch_id' },
    { table: 'backup_metadata', branchCol: 'branch_id' },
];

/**
 * Purga datos transaccionales de PostgreSQL para resets vencidos (>30 días)
 * Se ejecuta periódicamente (ej: cada 24h)
 */
async function purgeExpiredResets() {
    const client = await pool.connect();
    try {
        // Buscar resets pendientes de purga cuyo plazo ya venció
        const pendingResets = await client.query(`
            SELECT dr.id, dr.tenant_id, dr.branch_id, dr.reset_scope, dr.reset_at, dr.purge_after
            FROM data_resets dr
            WHERE dr.purged_at IS NULL
              AND dr.purge_after <= NOW()
            ORDER BY dr.reset_at ASC
        `);

        if (pendingResets.rows.length === 0) {
            return;
        }

        console.log(`\n[PURGE-JOB] 🗑️ ${pendingResets.rows.length} reset(s) pendiente(s) de purga`);

        for (const reset of pendingResets.rows) {
            await purgeResetData(client, reset);
        }

        console.log('[PURGE-JOB] ✅ Purga completada\n');
    } catch (error) {
        console.error('[PURGE-JOB] ❌ Error en purga:', error.message);
    } finally {
        client.release();
    }
}

/**
 * Purga los datos de un reset específico
 */
async function purgeResetData(client, reset) {
    const { id: resetId, tenant_id, branch_id, reset_scope, reset_at } = reset;
    const recordsPurged = {};

    console.log(`[PURGE-JOB] 🔄 Purgando reset #${resetId} (scope: ${reset_scope}, tenant: ${tenant_id}, branch: ${branch_id || 'ALL'})`);

    try {
        await client.query('BEGIN');

        // Determinar branches a purgar
        let branchIds = [];
        if (reset_scope === 'branch' && branch_id) {
            branchIds = [branch_id];
        } else {
            // Tenant completo: obtener todas las branches
            const branches = await client.query(
                'SELECT id FROM branches WHERE tenant_id = $1',
                [tenant_id]
            );
            branchIds = branches.rows.map(b => b.id);
        }

        if (branchIds.length === 0) {
            console.log(`[PURGE-JOB]    No hay sucursales para purgar`);
            await client.query('COMMIT');
            return;
        }

        console.log(`[PURGE-JOB]    Branches a purgar: [${branchIds.join(', ')}]`);

        for (const tableDef of TRANSACTIONAL_TABLES_ORDERED) {
            try {
                // Verificar si la tabla existe
                const tableExists = await client.query(`
                    SELECT EXISTS (
                        SELECT FROM information_schema.tables
                        WHERE table_name = $1
                    )
                `, [tableDef.table]);

                if (!tableExists.rows[0].exists) continue;

                let result;

                if (tableDef.parent && !tableDef.branchCol) {
                    // Tabla hija (FK a tabla padre) - borrar via subquery
                    // Verificar si la columna FK existe
                    const fkExists = await client.query(`
                        SELECT EXISTS (
                            SELECT FROM information_schema.columns
                            WHERE table_name = $1 AND column_name = $2
                        )
                    `, [tableDef.table, tableDef.fk]);

                    if (!fkExists.rows[0].exists) continue;

                    const parentBranchCol = TRANSACTIONAL_TABLES_ORDERED.find(t => t.table === tableDef.parent)?.branchCol || 'branch_id';

                    result = await client.query(`
                        DELETE FROM ${tableDef.table}
                        WHERE ${tableDef.fk} IN (
                            SELECT id FROM ${tableDef.parent}
                            WHERE ${parentBranchCol} = ANY($1)
                              AND tenant_id = $2
                              AND created_at < $3
                        )
                    `, [branchIds, tenant_id, reset_at]);
                } else if (tableDef.branchCol) {
                    // Tabla con branch_id directo
                    // Verificar si tiene tenant_id
                    const hasTenantCol = await client.query(`
                        SELECT EXISTS (
                            SELECT FROM information_schema.columns
                            WHERE table_name = $1 AND column_name = 'tenant_id'
                        )
                    `, [tableDef.table]);

                    if (hasTenantCol.rows[0].exists) {
                        result = await client.query(`
                            DELETE FROM ${tableDef.table}
                            WHERE ${tableDef.branchCol} = ANY($1)
                              AND tenant_id = $2
                              AND created_at < $3
                        `, [branchIds, tenant_id, reset_at]);
                    } else {
                        result = await client.query(`
                            DELETE FROM ${tableDef.table}
                            WHERE ${tableDef.branchCol} = ANY($1)
                              AND created_at < $2
                        `, [branchIds, reset_at]);
                    }
                }

                if (result && result.rowCount > 0) {
                    recordsPurged[tableDef.table] = result.rowCount;
                    console.log(`[PURGE-JOB]    🗑️ ${tableDef.table}: ${result.rowCount} registros`);
                }
            } catch (tableErr) {
                // Tabla puede no existir o tener schema diferente - continuar
                console.log(`[PURGE-JOB]    ⚠️ ${tableDef.table}: ${tableErr.message}`);
            }
        }

        // Marcar reset como purgado
        await client.query(`
            UPDATE data_resets
            SET purged_at = NOW(), records_purged = $1
            WHERE id = $2
        `, [JSON.stringify(recordsPurged), resetId]);

        await client.query('COMMIT');

        const totalPurged = Object.values(recordsPurged).reduce((a, b) => a + b, 0);
        console.log(`[PURGE-JOB] ✅ Reset #${resetId} purgado: ${totalPurged} registros eliminados`);

    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        console.error(`[PURGE-JOB] ❌ Error purgando reset #${resetId}:`, error.message);
    }
}

module.exports = { purgeExpiredResets };
