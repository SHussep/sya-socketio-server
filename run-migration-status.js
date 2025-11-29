// run-migration-status.js
// Script para ejecutar la migración de status en repartidor_returns

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? {
        rejectUnauthorized: false
    } : false
});

async function runMigration() {
    try {
        console.log('🔧 Iniciando migración de status...\n');

        // Leer el archivo SQL
        const migrationPath = path.join(__dirname, 'migrations', 'add_status_to_repartidor_returns.sql');
        const sql = fs.readFileSync(migrationPath, 'utf8');

        console.log('📄 Ejecutando SQL...\n');
        console.log(sql);
        console.log('\n');

        // Ejecutar la migración
        await pool.query(sql);

        console.log('✅ Migración completada exitosamente!\n');

        // Verificar que la columna existe
        const checkResult = await pool.query(`
            SELECT column_name, data_type, column_default
            FROM information_schema.columns
            WHERE table_name = 'repartidor_returns'
            AND column_name = 'status'
        `);

        if (checkResult.rows.length > 0) {
            console.log('✅ Columna "status" verificada:');
            console.log(checkResult.rows[0]);
        } else {
            console.log('⚠️ No se encontró la columna "status"');
        }

        // Mostrar estadísticas
        const stats = await pool.query(`
            SELECT
                status,
                COUNT(*) as count
            FROM repartidor_returns
            GROUP BY status
            ORDER BY count DESC
        `);

        console.log('\n📊 Estadísticas de registros:');
        stats.rows.forEach(row => {
            console.log(`   ${row.status}: ${row.count} registros`);
        });

        await pool.end();
        console.log('\n✅ Migración finalizada correctamente');
        process.exit(0);

    } catch (error) {
        console.error('❌ Error ejecutando migración:', error);
        await pool.end();
        process.exit(1);
    }
}

runMigration();
