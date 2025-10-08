const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
    connectionString: 'postgresql://sya_admin:qJ1haIaPp7m7OFMyicWSplPlGoNL1GpF@dpg-d3i8dv3e5dus738tm5rg-a.oregon-postgres.render.com/sya_db_oe4v',
    ssl: { rejectUnauthorized: false }
});

async function runMigration() {
    console.log('\n🔧 EJECUTANDO MIGRACIÓN 003B: ACTUALIZAR TABLA SHIFTS\n');

    try {
        const sqlPath = path.join(__dirname, 'migrations', '003_alter_shifts_table.sql');
        const sqlScript = fs.readFileSync(sqlPath, 'utf8');

        console.log('📝 Ejecutando script SQL...\n');
        await pool.query(sqlScript);

        console.log('✅ Migración ejecutada exitosamente\n');
        console.log('🔍 Verificando estructura actualizada de tabla shifts...\n');

        const result = await pool.query(`
            SELECT column_name, data_type, is_nullable, column_default
            FROM information_schema.columns
            WHERE table_name = 'shifts'
            ORDER BY ordinal_position
        `);

        console.table(result.rows);

        await pool.end();
        process.exit(0);

    } catch (error) {
        console.error('❌ Error ejecutando migración:', error.message);
        console.error('Detalles:', error);
        await pool.end();
        process.exit(1);
    }
}

runMigration();
