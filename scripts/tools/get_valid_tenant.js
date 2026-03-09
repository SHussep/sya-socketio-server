// Obtener un tenant válido de la base de datos
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function getValidTenant() {
    try {
        const result = await pool.query(`
            SELECT t.id as tenant_id, t.tenant_code, t.business_name,
                   b.id as branch_id, b.name as branch_name
            FROM tenants t
            JOIN branches b ON b.tenant_id = t.id
            ORDER BY t.id
            LIMIT 1
        `);

        if (result.rows.length === 0) {
            console.log('❌ No hay tenants en la base de datos');
            process.exit(1);
        }

        const tenant = result.rows[0];
        console.log('\n✅ Tenant válido encontrado:\n');
        console.log(`   Tenant ID: ${tenant.tenant_id}`);
        console.log(`   Código: ${tenant.tenant_code}`);
        console.log(`   Negocio: ${tenant.business_name}`);
        console.log(`   Branch ID: ${tenant.branch_id}`);
        console.log(`   Sucursal: ${tenant.branch_name}\n`);

        await pool.end();
        return tenant;

    } catch (error) {
        console.error('❌ Error:', error.message);
        await pool.end();
        process.exit(1);
    }
}

getValidTenant();
