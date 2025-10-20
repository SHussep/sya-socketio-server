// Script para probar la query exacta del snapshot
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function test() {
    try {
        const tenantId = 7;
        const branchId = 7;

        console.log('\n=== PROBANDO QUERY DEL SNAPSHOT ===\n');
        console.log(`Tenant ID: ${tenantId}`);
        console.log(`Branch ID: ${branchId}\n`);

        // Esta es la query EXACTA que usa el endpoint
        const employeesResult = await pool.query(
            `SELECT e.* FROM employees e
             INNER JOIN employee_branches eb ON e.id = eb.employee_id
             WHERE e.tenant_id = $1 AND eb.branch_id = $2`,
            [tenantId, branchId]
        );

        console.log(`Empleados encontrados: ${employeesResult.rows.length}\n`);

        if (employeesResult.rows.length === 0) {
            console.log('❌ LA QUERY NO DEVUELVE EMPLEADOS\n');

            // Verificar por separado
            console.log('Verificando...\n');

            const empCheck = await pool.query(
                'SELECT * FROM employees WHERE tenant_id = $1',
                [tenantId]
            );
            console.log(`  Empleados en tabla employees: ${empCheck.rows.length}`);

            const ebCheck = await pool.query(
                'SELECT * FROM employee_branches eb INNER JOIN employees e ON eb.employee_id = e.id WHERE e.tenant_id = $1',
                [tenantId]
            );
            console.log(`  Empleados en employee_branches: ${ebCheck.rows.length}`);

            const ebCheckBranch = await pool.query(
                'SELECT * FROM employee_branches WHERE branch_id = $1',
                [branchId]
            );
            console.log(`  Employee_branches para branch ${branchId}: ${ebCheckBranch.rows.length}`);

        } else {
            console.log('✅ EMPLEADOS ENCONTRADOS:\n');
            employeesResult.rows.forEach(emp => {
                console.log(`  - ${emp.full_name} (${emp.email})`);
                console.log(`    ID: ${emp.id} | Username: ${emp.username} | Role: ${emp.role}`);
                console.log(`    Main Branch: ${emp.main_branch_id}`);
                console.log(`    Created: ${emp.created_at}`);
                console.log();
            });
        }

        await pool.end();
        process.exit(0);
    } catch (error) {
        console.error('Error:', error);
        await pool.end();
        process.exit(1);
    }
}

test();
