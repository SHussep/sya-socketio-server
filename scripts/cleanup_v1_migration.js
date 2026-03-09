const { Pool } = require('pg');

const pool = new Pool({
    connectionString: 'postgresql://sya_admin:qJ1haIaPp7m7OFMyicWSplPlGoNL1GpF@dpg-d3i8dv3e5dus738tm5rg-a.oregon-postgres.render.com/sya_db_oe4v',
    ssl: { rejectUnauthorized: false }
});

async function run() {
    const client = await pool.connect();
    try {
        console.log('=== LIMPIEZA DE MIGRACIÓN V1 - Tenant 34 ===\n');

        // 1. Mostrar estado actual
        const ebBefore = await client.query(`SELECT COUNT(*) as total FROM employee_branches WHERE tenant_id = 34`);
        console.log(`employee_branches antes: ${ebBefore.rows[0].total} registros`);

        const cbBefore = await client.query(`SELECT COUNT(*) as total FROM cliente_branches WHERE tenant_id = 34`);
        console.log(`cliente_branches antes: ${cbBefore.rows[0].total} registros`);

        // 2. Limpiar registros de migración V1
        const ebDeleted = await client.query(`DELETE FROM employee_branches WHERE tenant_id = 34 RETURNING id`);
        console.log(`\n✅ employee_branches eliminados: ${ebDeleted.rowCount}`);

        const cbDeleted = await client.query(`DELETE FROM cliente_branches WHERE tenant_id = 34 RETURNING id`);
        console.log(`✅ cliente_branches eliminados: ${cbDeleted.rowCount}`);

        console.log('\n=== LIMPIEZA COMPLETADA ===');
        console.log('La migración V2 en la app desktop recreará los registros correctos y los sincronizará.');

    } finally {
        client.release();
        await pool.end();
    }
}

run().catch(e => { console.error(e); process.exit(1); });
