const { Pool } = require('pg');

const pool = new Pool({
    connectionString: 'postgresql://sya_admin:qJ1haIaPp7m7OFMyicWSplPlGoNL1GpF@dpg-d3i8dv3e5dus738tm5rg-a.oregon-postgres.render.com/sya_db_oe4v',
    ssl: { rejectUnauthorized: false }
});

async function checkShiftsTable() {
    try {
        console.log('\n🔍 Verificando tabla shifts...\n');

        // Verificar si existe
        const exists = await pool.query(`
            SELECT EXISTS (
                SELECT FROM information_schema.tables
                WHERE table_name = 'shifts'
            );
        `);

        console.log('¿Existe tabla shifts?', exists.rows[0].exists);

        if (exists.rows[0].exists) {
            console.log('\n📋 Estructura actual de shifts:\n');
            const columns = await pool.query(`
                SELECT column_name, data_type, is_nullable, column_default
                FROM information_schema.columns
                WHERE table_name = 'shifts'
                ORDER BY ordinal_position
            `);
            console.table(columns.rows);

            console.log('\n📊 Total de registros:', (await pool.query('SELECT COUNT(*) FROM shifts')).rows[0].count);
        } else {
            console.log('❌ La tabla shifts NO existe');
        }

        await pool.end();
        process.exit(0);

    } catch (error) {
        console.error('❌ Error:', error.message);
        await pool.end();
        process.exit(1);
    }
}

checkShiftsTable();
