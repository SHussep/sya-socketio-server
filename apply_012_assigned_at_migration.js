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
    console.log('║   🔧 MIGRACIÓN 012: assigned_at a employee_branches    ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    try {
        const migrationPath = path.join(__dirname, 'migrations', '012_add_assigned_at_to_employee_branches.sql');
        console.log(`📂 Leyendo migración: ${migrationPath}\n`);

        const sql = fs.readFileSync(migrationPath, 'utf8');

        console.log('🔄 Ejecutando migración...\n');
        await pool.query(sql);

        console.log('✅ Migración ejecutada exitosamente\n');

        console.log('🔍 Verificando columna assigned_at...');
        const columnCheck = await pool.query(`
            SELECT column_name, data_type, column_default
            FROM information_schema.columns
            WHERE table_name = 'employee_branches'
            AND column_name = 'assigned_at'
        `);

        if (columnCheck.rows.length > 0) {
            const col = columnCheck.rows[0];
            console.log(`✅ Columna encontrada:`);
            console.log(`   Nombre: ${col.column_name}`);
            console.log(`   Tipo: ${col.data_type}`);
            console.log(`   Default: ${col.column_default || 'N/A'}\n`);
        }

        console.log('📋 Columnas actuales de employee_branches:');
        const allColumns = await pool.query(`
            SELECT column_name, data_type
            FROM information_schema.columns
            WHERE table_name = 'employee_branches'
            ORDER BY ordinal_position
        `);

        allColumns.rows.forEach((col, index) => {
            console.log(`   ${(index + 1).toString().padStart(2, '0')}. ${col.column_name.padEnd(25)} ${col.data_type}`);
        });

        console.log('\n═══════════════════════════════════════════════════════════');
        console.log('✅ Migración 012 completada exitosamente');
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
