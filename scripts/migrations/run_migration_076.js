const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function runMigration() {
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║   🚀 MIGRATION 076: Guardian Logs (Suspicious Weighing) ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    try {
        // Leer archivo SQL
        const migrationPath = path.join(__dirname, 'migrations', '076_create_suspicious_weighing_logs.sql');
        console.log(`📂 Leyendo migración: ${migrationPath}\n`);

        const sql = fs.readFileSync(migrationPath, 'utf8');

        // Ejecutar migración
        console.log('🔄 Ejecutando migración 076...\n');
        await pool.query(sql);

        console.log('\n✅ Migración 076 ejecutada exitosamente');

        // Verificar tabla creada
        const tableCheck = await pool.query(`
            SELECT column_name, data_type, is_nullable
            FROM information_schema.columns
            WHERE table_name = 'suspicious_weighing_logs'
            ORDER BY ordinal_position
        `);

        console.log(`\n📊 Tabla suspicious_weighing_logs creada con ${tableCheck.rows.length} columnas:`);
        console.log('\n   Columnas offline-first:');
        const offlineFields = ['global_id', 'terminal_id', 'local_op_seq', 'created_local_utc', 'device_event_raw'];
        tableCheck.rows
            .filter(col => offlineFields.includes(col.column_name))
            .forEach(col => {
                console.log(`   ✓ ${col.column_name.padEnd(25)} ${col.data_type.padEnd(20)} nullable: ${col.is_nullable}`);
            });

        console.log('\n═══════════════════════════════════════════════════════════');
        console.log('✅ Migration 076 completada - Guardian Logs listos');
        console.log('═══════════════════════════════════════════════════════════\n');

        await pool.end();
        process.exit(0);

    } catch (error) {
        console.error('\n❌ Error ejecutando migración 076:');
        console.error(error.message);
        console.error('\nStack trace:');
        console.error(error.stack);

        await pool.end();
        process.exit(1);
    }
}

// Ejecutar
runMigration();
