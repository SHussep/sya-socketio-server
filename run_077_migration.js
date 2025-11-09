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
    console.log('║   🚀 MIGRACIÓN 077 - Scale Disconnection Logs           ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    try {
        // Leer archivo SQL
        const migrationPath = path.join(__dirname, 'migrations', '077_create_scale_disconnection_logs.sql');
        console.log(`📂 Leyendo migración: ${migrationPath}\n`);

        const sql = fs.readFileSync(migrationPath, 'utf8');

        // Ejecutar migración
        console.log('🔄 Ejecutando migración 077...\n');
        const result = await pool.query(sql);

        console.log('✅ Migración 077 ejecutada exitosamente\n');

        // Verificar tabla creada
        const tableCheck = await pool.query(`
            SELECT column_name, data_type
            FROM information_schema.columns
            WHERE table_name = 'scale_disconnection_logs'
            ORDER BY ordinal_position
        `);

        console.log(`📊 Tabla scale_disconnection_logs creada con ${tableCheck.rows.length} columnas:`);
        tableCheck.rows.forEach((col, index) => {
            console.log(`   ${(index + 1).toString().padStart(2, '0')}. ${col.column_name.padEnd(25)} - ${col.data_type}`);
        });

        console.log('\n═══════════════════════════════════════════════════════════');
        console.log('✅ Migración 077 completada exitosamente');
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
