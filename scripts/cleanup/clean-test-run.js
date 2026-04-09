#!/usr/bin/env node
// scripts/cleanup/clean-test-run.js
//
// Manual cleanup of QA test data from PostgreSQL.
// Usage: node scripts/cleanup/clean-test-run.js [--tenant-id=1]
//
// Deletes all records with terminal_id LIKE 'TEST-%' in reverse FK order.
// Safe to run multiple times (idempotent).

const { Pool } = require('pg');

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
    console.error('ERROR: DATABASE_URL env var is required');
    process.exit(1);
}

const args = process.argv.slice(2);
const tenantIdArg = args.find(a => a.startsWith('--tenant-id='));
const TENANT_ID = tenantIdArg ? parseInt(tenantIdArg.split('=')[1]) : 1;

const pool = new Pool({
    connectionString: DB_URL,
    ssl: DB_URL.includes('localhost') ? false : { rejectUnauthorized: false }
});

const CLEANUP_QUERIES = [
    'DELETE FROM cancelaciones_bitacora WHERE terminal_id LIKE \'TEST-%\' AND tenant_id = $1',
    'DELETE FROM credit_payments WHERE terminal_id LIKE \'TEST-%\' AND tenant_id = $1',
    `DELETE FROM ventas_detalle WHERE id_venta IN (
        SELECT id_venta FROM ventas WHERE terminal_id LIKE 'TEST-%' AND tenant_id = $1
    )`,
    'DELETE FROM ventas WHERE terminal_id LIKE \'TEST-%\' AND tenant_id = $1',
    `DELETE FROM repartidor_returns WHERE assignment_id IN (
        SELECT id FROM repartidor_assignments WHERE terminal_id LIKE 'TEST-%' AND tenant_id = $1
    )`,
    `DELETE FROM repartidor_debts WHERE assignment_id IN (
        SELECT id FROM repartidor_assignments WHERE terminal_id LIKE 'TEST-%' AND tenant_id = $1
    )`,
    `DELETE FROM repartidor_liquidations WHERE assignment_id IN (
        SELECT id FROM repartidor_assignments WHERE terminal_id LIKE 'TEST-%' AND tenant_id = $1
    )`,
    'DELETE FROM repartidor_assignments WHERE terminal_id LIKE \'TEST-%\' AND tenant_id = $1',
    `DELETE FROM cash_cuts WHERE shift_id IN (
        SELECT id FROM shifts WHERE terminal_id LIKE 'TEST-%' AND tenant_id = $1
    )`,
    'DELETE FROM expenses WHERE terminal_id LIKE \'TEST-%\' AND tenant_id = $1',
    'DELETE FROM deposits WHERE terminal_id LIKE \'TEST-%\' AND tenant_id = $1',
    'DELETE FROM withdrawals WHERE terminal_id LIKE \'TEST-%\' AND tenant_id = $1',
    'DELETE FROM shifts WHERE terminal_id LIKE \'TEST-%\' AND tenant_id = $1',
];

async function main() {
    console.log(`\n🧹 Cleaning TEST-* records for tenant_id=${TENANT_ID}\n`);
    let totalDeleted = 0;

    for (const q of CLEANUP_QUERIES) {
        try {
            const result = await pool.query(q, [TENANT_ID]);
            const table = q.match(/DELETE FROM (\w+)/)?.[1] || 'unknown';
            if (result.rowCount > 0) {
                console.log(`  ✅ ${table}: ${result.rowCount} deleted`);
                totalDeleted += result.rowCount;
            }
        } catch (err) {
            const table = q.match(/DELETE FROM (\w+)/)?.[1] || 'unknown';
            console.warn(`  ⚠️  ${table}: ${err.message}`);
        }
    }

    console.log(`\n✅ Done. Total records deleted: ${totalDeleted}`);
    await pool.end();
}

main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
