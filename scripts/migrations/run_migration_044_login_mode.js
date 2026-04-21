/**
 * Migration 044: agrega telemetry_events.login_mode + índice de reporting.
 * Idempotente (IF NOT EXISTS).
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
    const sqlPath = path.join(__dirname, '..', '..', 'migrations', '044_telemetry_login_mode.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');

    const client = await pool.connect();
    try {
        console.log('🔄 Aplicando 044_telemetry_login_mode.sql...');
        await client.query(sql);
        console.log('✅ Migration 044 aplicada');

        const check = await client.query(`
            SELECT column_name, data_type, is_nullable
            FROM information_schema.columns
            WHERE table_name = 'telemetry_events' AND column_name = 'login_mode'
        `);
        console.log('   login_mode:', check.rows[0] || '(no encontrada)');

        const idx = await client.query(`
            SELECT indexname FROM pg_indexes
            WHERE tablename = 'telemetry_events' AND indexname = 'idx_telemetry_login_mode'
        `);
        console.log('   índice:', idx.rows[0]?.indexname || '(no encontrado)');
    } catch (err) {
        console.error('❌ Error:', err.message);
        process.exitCode = 1;
    } finally {
        client.release();
        await pool.end();
    }
}

run();
