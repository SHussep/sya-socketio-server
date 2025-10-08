const { Pool } = require('pg');

const pool = new Pool({
    connectionString: 'postgresql://sya_admin:qJ1haIaPp7m7OFMyicWSplPlGoNL1GpF@dpg-d3i8dv3e5dus738tm5rg-a.oregon-postgres.render.com/sya_db_oe4v',
    ssl: { rejectUnauthorized: false }
});

async function forceClean() {
    console.log('\n🔥 LIMPIEZA FORZADA CON CASCADE...\n');

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // Deshabilitar temporalmente las foreign key constraints
        await client.query('SET CONSTRAINTS ALL DEFERRED');

        const tables = [
            'expenses',
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
                const result = await client.query(`TRUNCATE TABLE ${table} CASCADE`);
                console.log(`✅ ${table}: TRUNCATED`);
            } catch (error) {
                console.log(`⚠️  ${table}: ${error.message}`);
            }
        }

        await client.query('COMMIT');

        console.log('\n📊 VERIFICANDO ESTADO FINAL...\n');

        for (const table of tables) {
            try {
                const result = await client.query(`SELECT COUNT(*) as count FROM ${table}`);
                const count = parseInt(result.rows[0].count);
                if (count === 0) {
                    console.log(`✅ ${table}: vacía`);
                } else {
                    console.log(`❌ ${table}: todavía tiene ${count} registros`);
                }
            } catch (error) {
                console.log(`⚠️  ${table}: no existe`);
            }
        }

        console.log('\n✅ LIMPIEZA COMPLETADA\n');

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ Error:', error.message);
    } finally {
        client.release();
        await pool.end();
    }
}

forceClean();
