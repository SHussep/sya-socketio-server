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
    console.log('║   📊 MIGRACIÓN 079 - Employee Daily Metrics             ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    try {
        // Leer archivo SQL
        const migrationPath = path.join(__dirname, 'migrations', '079_create_employee_daily_metrics.sql');
        console.log(`📂 Leyendo migración: ${migrationPath}\n`);

        const sql = fs.readFileSync(migrationPath, 'utf8');

        // Ejecutar migración
        console.log('🔄 Ejecutando migración 079...\n');
        const result = await pool.query(sql);

        console.log('✅ Migración 079 ejecutada exitosamente\n');

        // Verificar tabla creada
        const tableCheck = await pool.query(`
            SELECT column_name, data_type
            FROM information_schema.columns
            WHERE table_name = 'employee_daily_metrics'
            ORDER BY ordinal_position
        `);

        console.log(`📊 Tabla employee_daily_metrics creada con ${tableCheck.rows.length} columnas:`);
        tableCheck.rows.forEach((col, index) => {
            console.log(`   ${(index + 1).toString().padStart(2, '0')}. ${col.column_name.padEnd(35)} - ${col.data_type}`);
        });

        // Verificar índices
        const indexCheck = await pool.query(`
            SELECT indexname
            FROM pg_indexes
            WHERE tablename = 'employee_daily_metrics'
            ORDER BY indexname
        `);

        console.log(`\n🔑 Índices creados (${indexCheck.rows.length}):`);
        indexCheck.rows.forEach((idx, i) => {
            console.log(`   ${(i + 1).toString().padStart(2, '0')}. ${idx.indexname}`);
        });

        console.log('\n═══════════════════════════════════════════════════════════');
        console.log('✅ Migración 079 completada exitosamente');
        console.log('═══════════════════════════════════════════════════════════\n');

        await pool.end();
        process.exit(0);

    } catch (error) {
        console.error('\n❌ Error ejecutando migración:');
        console.error(error.message);
        console.error('\nStack trace:');
        console.error(error.stack);

        await pool.end();
        process.exit(1);
    }
}

// Ejecutar
runMigration();
