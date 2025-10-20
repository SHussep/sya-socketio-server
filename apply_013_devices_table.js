const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function applyMigration() {
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║   🔧 MIGRACIÓN 013: Crear tabla devices                ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    try {
        const migrationPath = path.join(__dirname, 'migrations', '013_create_devices_table.sql');
        console.log(`📂 Leyendo migración: ${migrationPath}\n`);

        const sql = fs.readFileSync(migrationPath, 'utf8');

        console.log('🔄 Ejecutando migración...\n');
        await pool.query(sql);

        console.log('✅ Migración ejecutada exitosamente\n');

        console.log('🔍 Verificando tabla devices...');
        const tableCheck = await pool.query(`
            SELECT column_name, data_type, is_nullable
            FROM information_schema.columns
            WHERE table_name = 'devices'
            ORDER BY ordinal_position
        `);

        if (tableCheck.rows.length > 0) {
            console.log('✅ Tabla devices creada con las siguientes columnas:\n');
            tableCheck.rows.forEach((col, index) => {
                const nullable = col.is_nullable === 'YES' ? 'NULL' : 'NOT NULL';
                console.log(`   ${(index + 1).toString().padStart(2, '0')}. ${col.column_name.padEnd(25)} ${col.data_type.padEnd(20)} ${nullable}`);
            });
        }

        console.log('\n═══════════════════════════════════════════════════════════');
        console.log('✅ Migración 013 completada exitosamente');
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

applyMigration();
