/**
 * Migration 045: agrega global_id a employee_branches para idempotencia offline-first.
 * Idempotente (IF NOT EXISTS + backfill condicional).
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function run() {
    const sqlPath = path.join(__dirname, '..', '..', 'migrations', '045_employee_branches_global_id.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');

    const client = await pool.connect();
    try {
        console.log('🔄 Aplicando 045_employee_branches_global_id.sql...');
        await client.query(sql);
        console.log('✅ Migration 045 aplicada');

        const check = await client.query(`
            SELECT column_name, data_type, is_nullable
            FROM information_schema.columns
            WHERE table_name = 'employee_branches' AND column_name = 'global_id'
        `);
        console.log('   global_id:', check.rows[0] || '(no encontrada)');

        const constraint = await client.query(`
            SELECT conname FROM pg_constraint
            WHERE conname = 'employee_branches_global_id_key'
        `);
        console.log('   constraint UNIQUE:', constraint.rows[0]?.conname || '(no encontrado)');

        const filled = await client.query(`
            SELECT COUNT(*) AS total,
                   COUNT(global_id) AS con_global_id,
                   COUNT(*) FILTER (WHERE global_id IS NULL) AS sin_global_id
            FROM employee_branches
        `);
        console.log('   filas:', filled.rows[0]);
    } catch (err) {
        console.error('❌ Error:', err.message);
        process.exitCode = 1;
    } finally {
        client.release();
        await pool.end();
    }
}

run();
