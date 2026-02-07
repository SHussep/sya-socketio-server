const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function main() {
    const tenants = await pool.query(`
        SELECT
            t.id,
            t.tenant_code,
            t.business_name,
            (SELECT COUNT(*) FROM branches WHERE tenant_id = t.id) as branches,
            (SELECT COUNT(*) FROM ventas WHERE tenant_id = t.id) as ventas,
            (SELECT COUNT(*) FROM expenses WHERE tenant_id = t.id) as gastos,
            (SELECT COUNT(*) FROM shifts WHERE tenant_id = t.id) as turnos,
            (SELECT COUNT(*) FROM repartidor_assignments WHERE tenant_id = t.id) as asignaciones
        FROM tenants t
        ORDER BY t.id
    `);

    console.log('\n=== TENANTS DISPONIBLES ===\n');
    console.log('ID   | Codigo      | Negocio                    | Sucursales | Ventas | Gastos | Turnos | Asignaciones');
    console.log('-----|-------------|----------------------------|------------|--------|--------|--------|-------------');

    for (const t of tenants.rows) {
        console.log(
            String(t.id).padEnd(4) + ' | ' +
            (t.tenant_code || '-').padEnd(11) + ' | ' +
            (t.business_name || '-').substring(0, 26).padEnd(26) + ' | ' +
            String(t.branches).padEnd(10) + ' | ' +
            String(t.ventas).padEnd(6) + ' | ' +
            String(t.gastos).padEnd(6) + ' | ' +
            String(t.turnos).padEnd(6) + ' | ' +
            t.asignaciones
        );
    }

    await pool.end();
}

main().catch(e => { console.error(e.message); process.exit(1); });
