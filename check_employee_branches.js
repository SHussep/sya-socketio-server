// Script para verificar employee_branches para tenant 7
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function check() {
    try {
        console.log('\n=== EMPLOYEE_BRANCHES PARA TENANT 7 ===\n');

        const result = await pool.query(`
            SELECT eb.*, e.full_name, e.email, b.name as branch_name
            FROM employee_branches eb
            INNER JOIN employees e ON eb.employee_id = e.id
            INNER JOIN branches b ON eb.branch_id = b.id
            WHERE e.tenant_id = 7
        `);

        console.log(`Total registros: ${result.rows.length}\n`);

        if (result.rows.length === 0) {
            console.log('❌ NO HAY REGISTROS EN employee_branches para tenant 7');
            console.log('   Esto explica por qué el snapshot no devuelve empleados!\n');
        } else {
            result.rows.forEach(row => {
                console.log(`Employee: ${row.full_name} (${row.email})`);
                console.log(`  Employee ID: ${row.employee_id}`);
                console.log(`  Branch: ${row.branch_name} (ID: ${row.branch_id})`);
                console.log(`  Can View: ${row.can_view_reports} | Can Sell: ${row.can_sell}`);
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

check();
