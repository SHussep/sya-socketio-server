// Script para ejecutar migración 004: Eliminar columna phone duplicada
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function runMigration() {
    const client = await pool.connect();
    try {
        console.log('🔄 Iniciando migración 004: Eliminar columna phone duplicada...\n');

        const sqlPath = path.join(__dirname, 'migrations', '004_remove_duplicate_phone_column.sql');
        const sql = fs.readFileSync(sqlPath, 'utf8');

        await client.query('BEGIN');
        await client.query(sql);
        await client.query('COMMIT');

        console.log('✅ Migración completada exitosamente!\n');

        // Verificar
        const columns = await client.query(`
            SELECT column_name
            FROM information_schema.columns
            WHERE table_name = 'employees' AND column_name LIKE '%phone%';
        `);

        console.log('📋 Columnas de teléfono restantes:');
        columns.rows.forEach(col => console.log(`   - ${col.column_name}`));

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ Error ejecutando migración:', error.message);
        process.exit(1);
    } finally {
        client.release();
        await pool.end();
    }
}

runMigration().catch(console.error);
