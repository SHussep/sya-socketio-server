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
    console.log('║   🔧 MIGRACIÓN 015: Agregar updated_at a tenants       ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    try {
        const client = await pool.connect();

        console.log('🔍 Verificando si la columna updated_at ya existe en tenants...');

        // Verificar si la columna ya existe
        const checkColumn = await client.query(`
            SELECT column_name
            FROM information_schema.columns
            WHERE table_name = 'tenants' AND column_name = 'updated_at'
        `);

        if (checkColumn.rows.length > 0) {
            console.log('✅ Columna updated_at ya existe en tenants\n');
            client.release();
            await pool.end();
            process.exit(0);
        }

        console.log('📝 Agregando columna updated_at a tenants...\n');

        // Agregar columna updated_at
        await client.query(`
            ALTER TABLE tenants
            ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        `);

        console.log('✅ Columna updated_at agregada a tenants\n');

        // Mostrar estructura actual de la tabla
        console.log('📋 Columnas actuales de la tabla tenants:');
        const allColumns = await client.query(`
            SELECT column_name, data_type, is_nullable, column_default
            FROM information_schema.columns
            WHERE table_name = 'tenants'
            ORDER BY ordinal_position
        `);

        allColumns.rows.forEach((col, index) => {
            const nullable = col.is_nullable === 'YES' ? 'NULL' : 'NOT NULL';
            const defaultValue = col.column_default ? `DEFAULT ${col.column_default}` : '';
            console.log(`   ${(index + 1).toString().padStart(2, '0')}. ${col.column_name.padEnd(20)} ${col.data_type.padEnd(20)} ${nullable} ${defaultValue}`);
        });

        console.log('\n═══════════════════════════════════════════════════════════');
        console.log('✅ Migración 015 completada exitosamente');
        console.log('═══════════════════════════════════════════════════════════\n');

        client.release();
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
