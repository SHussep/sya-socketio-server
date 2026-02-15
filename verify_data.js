require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function verifyData() {
    try {
        console.log('\n=== VERIFICANDO TENANTS ===');
        const tenants = await pool.query(
            'SELECT id, tenant_code, business_name, created_at FROM tenants ORDER BY created_at DESC LIMIT 5'
        );
        console.table(tenants.rows);

        console.log('\n=== VERIFICANDO BRANCHES ===');
        const branches = await pool.query(
            'SELECT id, tenant_id, branch_code, name, created_at FROM branches ORDER BY created_at DESC LIMIT 10'
        );
        console.table(branches.rows);

        console.log('\n=== VERIFICANDO EMPLOYEES ===');
        const employees = await pool.query(
            'SELECT id, tenant_id, email, full_name, role, main_branch_id, created_at FROM employees ORDER BY created_at DESC LIMIT 5'
        );
        console.table(employees.rows);

        console.log('\n=== VERIFICANDO EMPLOYEE_BRANCHES ===');
        const empBranches = await pool.query(
            'SELECT employee_id, branch_id, can_login, can_sell FROM employee_branches ORDER BY assigned_at DESC LIMIT 10'
        );
        console.table(empBranches.rows);

        console.log('\n=== VERIFICANDO SUBSCRIPTIONS ===');
        const subs = await pool.query(
            'SELECT id, name, price_monthly, max_branches, max_devices, max_employees FROM subscriptions ORDER BY id'
        );
        console.table(subs.rows);

        process.exit(0);
    } catch (error) {
        console.error('Error:', error.message);
        process.exit(1);
    }
}

verifyData();
