require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function checkUsers() {
    try {
        console.log('\n📊 USUARIOS EXISTENTES EN LA BD\n');

        const result = await pool.query(`
            SELECT
                t.id as tenant_id,
                t.tenant_code,
                t.business_name,
                e.id as employee_id,
                e.email,
                e.full_name,
                e.role,
                b.id as branch_id,
                b.branch_code,
                b.name as branch_name
            FROM tenants t
            LEFT JOIN employees e ON e.tenant_id = t.id
            LEFT JOIN branches b ON b.tenant_id = t.id
            ORDER BY t.id, e.id, b.id
            LIMIT 20
        `);

        console.log(`Total registros: ${result.rows.length}\n`);

        if (result.rows.length > 0) {
            result.rows.forEach(row => {
                console.log('─────────────────────────────────────');
                console.log(`Tenant: ${row.business_name} (${row.tenant_code})`);
                console.log(`  Tenant ID: ${row.tenant_id}`);
                console.log(`  Employee: ${row.full_name} (${row.role})`);
                console.log(`  Email: ${row.email}`);
                console.log(`  Employee ID: ${row.employee_id}`);
                console.log(`  Branch: ${row.branch_name} (${row.branch_code})`);
                console.log(`  Branch ID: ${row.branch_id}`);
            });
            console.log('─────────────────────────────────────\n');

            // Mostrar un usuario de ejemplo para usar en tests
            const firstUser = result.rows[0];
            console.log('✅ Usuario de ejemplo para tests:');
            console.log(`   Email: ${firstUser.email}`);
            console.log(`   Password: (usar la contraseña que configuraste al registrar)`);
            console.log(`   Tenant Code: ${firstUser.tenant_code}`);
        } else {
            console.log('❌ No hay usuarios en la base de datos');
        }

        await pool.end();
        process.exit(0);

    } catch (error) {
        console.error('❌ Error:', error.message);
        await pool.end();
        process.exit(1);
    }
}

checkUsers();
