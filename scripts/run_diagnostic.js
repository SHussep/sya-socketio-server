const { Pool } = require('pg');

const pool = new Pool({
    connectionString: 'postgresql://sya_admin:qJ1haIaPp7m7OFMyicWSplPlGoNL1GpF@dpg-d3i8dv3e5dus738tm5rg-a.oregon-postgres.render.com/sya_db_oe4v',
    ssl: { rejectUnauthorized: false }
});

async function run() {
    const client = await pool.connect();
    try {
        console.log('=== 1. SUCURSALES DEL TENANT 34 ===');
        const branches = await client.query(`SELECT id, name, branch_code, is_active FROM branches WHERE tenant_id = 34 ORDER BY id`);
        console.table(branches.rows);

        console.log('\n=== 2. CLIENTES DEL TENANT 34 ===');
        const customers = await client.query(`SELECT id, nombre, telefono, activo FROM customers WHERE tenant_id = 34 ORDER BY nombre`);
        console.table(customers.rows);

        // Check if cliente_branches exists
        const tableCheck = await client.query(`SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'cliente_branches')`);
        if (tableCheck.rows[0].exists) {
            console.log('\n=== 3. ASIGNACIONES CLIENTE-SUCURSAL (TODAS) ===');
            const cbAll = await client.query(`
                SELECT cb.id as assign_id, cb.customer_id, c.nombre, cb.branch_id, b.name as branch, cb.is_active, cb.assigned_at
                FROM cliente_branches cb
                JOIN customers c ON c.id = cb.customer_id
                JOIN branches b ON b.id = cb.branch_id
                WHERE cb.tenant_id = 34
                ORDER BY c.nombre, b.name
            `);
            console.table(cbAll.rows);

            console.log('\n=== 4. RESUMEN CLIENTES POR SUCURSAL ===');
            const cbSummary = await client.query(`
                SELECT b.id as branch_id, b.name as branch, COUNT(cb.id) as clientes
                FROM branches b
                LEFT JOIN cliente_branches cb ON cb.branch_id = b.id AND cb.is_active = true AND cb.tenant_id = 34
                WHERE b.tenant_id = 34
                GROUP BY b.id, b.name ORDER BY b.id
            `);
            console.table(cbSummary.rows);
        } else {
            console.log('\n=== 3-4. TABLA cliente_branches NO EXISTE AÚN (deploy pendiente) ===');
        }

        console.log('\n=== 5. EMPLEADOS DEL TENANT 34 ===');
        const emps = await client.query(`SELECT id, first_name, last_name, is_active FROM employees WHERE tenant_id = 34 ORDER BY first_name`);
        console.table(emps.rows);

        console.log('\n=== 6. ASIGNACIONES EMPLEADO-SUCURSAL (TODAS) ===');
        const ebAll = await client.query(`
            SELECT eb.id as assign_id, eb.employee_id,
                   e.first_name || ' ' || COALESCE(e.last_name, '') as empleado,
                   eb.branch_id, b.name as branch,
                   (eb.removed_at IS NULL) as is_active,
                   eb.tenant_id,
                   eb.assigned_at
            FROM employee_branches eb
            JOIN employees e ON e.id = eb.employee_id
            JOIN branches b ON b.id = eb.branch_id
            WHERE e.tenant_id = 34
            ORDER BY e.first_name, b.name
        `);
        console.table(ebAll.rows);

        console.log('\n=== 7. RESUMEN EMPLEADOS POR SUCURSAL ===');
        const ebSummary = await client.query(`
            SELECT b.id as branch_id, b.name as branch, COUNT(eb.id) as empleados
            FROM branches b
            LEFT JOIN employee_branches eb ON eb.branch_id = b.id AND eb.removed_at IS NULL
                AND eb.employee_id IN (SELECT id FROM employees WHERE tenant_id = 34)
            WHERE b.tenant_id = 34
            GROUP BY b.id, b.name ORDER BY b.id
        `);
        console.table(ebSummary.rows);

        // Verificar si employee_branches tiene tenant_id
        console.log('\n=== 8. COLUMNAS DE employee_branches ===');
        const cols = await client.query(`
            SELECT column_name, data_type, is_nullable
            FROM information_schema.columns
            WHERE table_name = 'employee_branches'
            ORDER BY ordinal_position
        `);
        console.table(cols.rows);

    } finally {
        client.release();
        await pool.end();
    }
}

run().catch(e => { console.error(e); process.exit(1); });
