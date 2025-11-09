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
    console.log('║   🧹 MIGRACIÓN 078 - Cleanup Obsolete Tables           ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    try {
        // Verificar estado antes de la migración
        console.log('📋 ANTES DE LA MIGRACIÓN:\n');

        const beforeCheck = await pool.query(`
            SELECT
                table_name,
                (SELECT COUNT(*) FROM information_schema.columns WHERE table_name = t.table_name) as column_count
            FROM information_schema.tables t
            WHERE table_name IN ('scale_disconnections', 'scale_disconnection_logs')
            ORDER BY table_name
        `);

        if (beforeCheck.rows.length > 0) {
            beforeCheck.rows.forEach(row => {
                console.log(`  ✓ Tabla: ${row.table_name} (${row.column_count} columnas)`);
            });
        }

        // Leer y ejecutar migración
        const migrationPath = path.join(__dirname, 'migrations', '078_cleanup_obsolete_tables.sql');
        console.log(`\n📂 Leyendo migración: ${migrationPath}\n`);

        const sql = fs.readFileSync(migrationPath, 'utf8');

        console.log('🔄 Ejecutando migración 078...\n');
        const result = await pool.query(sql);

        // Mostrar los mensajes NOTICE de PostgreSQL
        if (result.rows && result.rows.length > 0) {
            result.rows.forEach(row => {
                console.log(row);
            });
        }

        console.log('\n✅ Migración 078 ejecutada exitosamente\n');

        // Verificar estado después de la migración
        console.log('📋 DESPUÉS DE LA MIGRACIÓN:\n');

        const afterCheck = await pool.query(`
            SELECT
                table_name,
                (SELECT COUNT(*) FROM information_schema.columns WHERE table_name = t.table_name) as column_count
            FROM information_schema.tables t
            WHERE table_name IN ('scale_disconnections', 'scale_disconnection_logs')
            ORDER BY table_name
        `);

        if (afterCheck.rows.length > 0) {
            afterCheck.rows.forEach(row => {
                console.log(`  ✓ Tabla: ${row.table_name} (${row.column_count} columnas)`);
            });
        }

        // Verificar que scale_disconnections NO existe
        const obsoleteExists = afterCheck.rows.some(r => r.table_name === 'scale_disconnections');
        const newExists = afterCheck.rows.some(r => r.table_name === 'scale_disconnection_logs');

        console.log('\n═══════════════════════════════════════════════════════════');
        if (!obsoleteExists && newExists) {
            console.log('✅ ÉXITO: Tabla obsoleta eliminada, nueva tabla presente');
        } else if (obsoleteExists) {
            console.log('⚠️ ADVERTENCIA: Tabla obsoleta aún existe');
        } else if (!newExists) {
            console.log('❌ ERROR: Tabla nueva no existe');
        }
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
