const { Pool } = require('pg');

const pool = new Pool({
    connectionString: 'postgresql://sya_admin:qJ1haIaPp7m7OFMyicWSplPlGoNL1GpF@dpg-d3i8dv3e5dus738tm5rg-a.oregon-postgres.render.com/sya_db_oe4v',
    ssl: { rejectUnauthorized: false }
});

async function cleanDatabase() {
    console.log('\n🗑️  LIMPIANDO BASE DE DATOS COMPLETA...\n');

    try {
        // Orden de eliminación respetando foreign keys
        const tables = [
            'sales',
            'guardian_events',
            'employee_branches',
            'employees',
            'branches',
            'tenants',
            'subscriptions'
        ];

        for (const table of tables) {
            try {
                const result = await pool.query(`DELETE FROM ${table}`);
                console.log(`✅ ${table}: ${result.rowCount} registros eliminados`);
            } catch (error) {
                console.log(`⚠️  ${table}: ${error.message}`);
            }
        }

        console.log('\n📊 VERIFICANDO ESTADO FINAL...\n');

        // Verificar que todo esté vacío
        for (const table of tables) {
            try {
                const result = await pool.query(`SELECT COUNT(*) as count FROM ${table}`);
                const count = parseInt(result.rows[0].count);
                if (count === 0) {
                    console.log(`✅ ${table}: vacía`);
                } else {
                    console.log(`❌ ${table}: todavía tiene ${count} registros`);
                }
            } catch (error) {
                console.log(`⚠️  ${table}: no existe o error`);
            }
        }

        console.log('\n✅ LIMPIEZA COMPLETADA\n');

        await pool.end();
        process.exit(0);
    } catch (error) {
        console.error('❌ Error durante limpieza:', error.message);
        await pool.end();
        process.exit(1);
    }
}

cleanDatabase();
