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
    console.log('║   🔧 MIGRACIÓN 011: Agregar updated_at a branches      ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    try {
        // Leer archivo SQL
        const migrationPath = path.join(__dirname, 'migrations', '011_add_updated_at_to_branches.sql');
        console.log(`📂 Leyendo migración: ${migrationPath}\n`);

        const sql = fs.readFileSync(migrationPath, 'utf8');

        // Ejecutar migración
        console.log('🔄 Ejecutando migración...\n');
        await pool.query(sql);

        console.log('✅ Migración ejecutada exitosamente\n');

        // Verificar que la columna se agregó
        console.log('🔍 Verificando columna updated_at en tabla branches...');
        const columnCheck = await pool.query(`
            SELECT column_name, data_type, column_default
            FROM information_schema.columns
            WHERE table_name = 'branches'
            AND column_name = 'updated_at'
        `);

        if (columnCheck.rows.length > 0) {
            const col = columnCheck.rows[0];
            console.log(`✅ Columna encontrada:`);
            console.log(`   Nombre: ${col.column_name}`);
            console.log(`   Tipo: ${col.data_type}`);
            console.log(`   Default: ${col.column_default || 'N/A'}\n`);
        } else {
            console.log('⚠️  Columna no encontrada (puede que ya existiera)\n');
        }

        // Mostrar estructura de la tabla branches
        console.log('📋 Columnas actuales de la tabla branches:');
        const allColumns = await pool.query(`
            SELECT column_name, data_type, is_nullable, column_default
            FROM information_schema.columns
            WHERE table_name = 'branches'
            ORDER BY ordinal_position
        `);

        allColumns.rows.forEach((col, index) => {
            const nullable = col.is_nullable === 'YES' ? 'NULL' : 'NOT NULL';
            const defaultValue = col.column_default ? `DEFAULT ${col.column_default}` : '';
            console.log(`   ${(index + 1).toString().padStart(2, '0')}. ${col.column_name.padEnd(20)} ${col.data_type.padEnd(20)} ${nullable} ${defaultValue}`);
        });

        console.log('\n═══════════════════════════════════════════════════════════');
        console.log('✅ Migración 011 completada exitosamente');
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
applyMigration();
