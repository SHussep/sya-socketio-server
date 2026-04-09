/**
 * Auditoría completa de un tenant
 * Uso: node scripts/audit_tenant.js <tenantId>
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function audit(tenantId) {
    try {
        // Employee columns
        const ecols = await pool.query(`
            SELECT column_name FROM information_schema.columns WHERE table_name = 'employees' ORDER BY ordinal_position
        `);
        console.log('=== COLUMNAS employees ===');
        console.log(ecols.rows.map(r => r.column_name).join(', '));

        // Employees + branches
        const employees = await pool.query(`
            SELECT e.id, e.username, e.first_name, e.last_name, e.role_id, e.is_owner, e.main_branch_id,
                   array_agg(eb.branch_id ORDER BY eb.branch_id) as branch_ids
            FROM employees e
            LEFT JOIN employee_branches eb ON e.id = eb.employee_id AND eb.removed_at IS NULL
            WHERE e.tenant_id = $1
            GROUP BY e.id
        `, [tenantId]);
        console.log('\n=== EMPLEADOS + SUCURSALES ===');
        console.table(employees.rows);

        // Clientes
        try {
            const clientes = await pool.query('SELECT id, nombre, rfc FROM clientes WHERE tenant_id = $1 LIMIT 20', [tenantId]);
            console.log('\n=== CLIENTES ===');
            console.table(clientes.rows);
        } catch(e) {
            console.log('Clientes error:', e.message);
        }

        // cliente_branches
        try {
            const cb = await pool.query(`
                SELECT cb.cliente_id, c.nombre, cb.branch_id
                FROM cliente_branches cb
                JOIN clientes c ON cb.cliente_id = c.id
                WHERE cb.tenant_id = $1 AND cb.removed_at IS NULL
            `, [tenantId]);
            console.log('\n=== CLIENTES x SUCURSAL ===');
            console.table(cb.rows);
        } catch(e) {
            console.log('cliente_branches error:', e.message);
        }

        // Expense categories
        try {
            const expCats = await pool.query('SELECT id, name FROM expense_categories WHERE tenant_id = $1', [tenantId]);
            console.log('\n=== CATEGORÍAS GASTOS ===');
            console.table(expCats.rows);
        } catch(e) {
            console.log('Expense cats error:', e.message);
        }

        // Branch devices
        const devices = await pool.query(`
            SELECT id, branch_id, device_id, device_name, device_type, is_active
            FROM branch_devices WHERE tenant_id = $1
        `, [tenantId]);
        console.log('\n=== DISPOSITIVOS ===');
        console.table(devices.rows);

        // Licenses
        const licenses = await pool.query('SELECT id, branch_id, status FROM branch_licenses WHERE tenant_id = $1', [tenantId]);
        console.log('\n=== LICENCIAS ===');
        console.table(licenses.rows);

    } catch (err) {
        console.error('Error:', err.message);
    } finally {
        await pool.end();
    }
}

const tenantId = parseInt(process.argv[2]) || 52;
audit(tenantId);
