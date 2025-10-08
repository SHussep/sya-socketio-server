const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({
    connectionString: 'postgresql://sya_admin:qJ1haIaPp7m7OFMyicWSplPlGoNL1GpF@dpg-d3i8dv3e5dus738tm5rg-a.oregon-postgres.render.com/sya_db_oe4v',
    ssl: { rejectUnauthorized: false }
});

async function testDirectInsert() {
    console.log('\n🧪 PRUEBA DIRECTA DE INSERCIÓN\n');

    try {
        // 1. Verificar que existe subscription
        console.log('📋 Verificando subscriptions...');
        const subsResult = await pool.query("SELECT id, name FROM subscriptions WHERE name = 'Basic'");

        if (subsResult.rows.length === 0) {
            console.log('❌ No existe plan Basic');
            return;
        }

        const subscriptionId = subsResult.rows[0].id;
        console.log(`✅ Plan Basic encontrado: ID = ${subscriptionId}\n`);

        // 2. Crear tenant
        const tenantCode = `TEST${Date.now().toString().slice(-6)}`;
        const businessName = 'Test Direct Insert';
        const email = `test${Date.now()}@direct.com`;

        console.log(`📝 Creando tenant: ${tenantCode}...`);

        const tenantResult = await pool.query(`
            INSERT INTO tenants (tenant_code, business_name, email, phone_number, address,
                                 subscription_status, subscription_id, trial_ends_at)
            VALUES ($1, $2, $3, $4, $5, 'trial', $6, $7)
            RETURNING id, tenant_code, business_name
        `, [
            tenantCode,
            businessName,
            email,
            '5551234567',
            'Test Address',
            subscriptionId,
            new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
        ]);

        const tenant = tenantResult.rows[0];
        console.log(`✅ Tenant creado: ID = ${tenant.id}, Code = ${tenant.tenant_code}\n`);

        // 3. Crear employee
        const hashedPassword = await bcrypt.hash('test1234', 10);
        console.log(`📝 Creando employee...`);

        const employeeResult = await pool.query(`
            INSERT INTO employees (tenant_id, username, full_name, email, password, role, is_active)
            VALUES ($1, $2, $3, $4, $5, 'admin', true)
            RETURNING id, username, full_name
        `, [tenant.id, 'testuser', 'Test User', email, hashedPassword]);

        const employee = employeeResult.rows[0];
        console.log(`✅ Employee creado: ID = ${employee.id}, Username = ${employee.username}\n`);

        // 4. Crear branch
        const branchCode = `${tenantCode}-MAIN`;
        console.log(`📝 Creando branch: ${branchCode}...`);

        const branchResult = await pool.query(`
            INSERT INTO branches (tenant_id, branch_code, name, address, is_active)
            VALUES ($1, $2, $3, $4, true)
            RETURNING id, branch_code, name
        `, [tenant.id, branchCode, `${businessName} - Principal`, 'N/A']);

        const branch = branchResult.rows[0];
        console.log(`✅ Branch creado: ID = ${branch.id}, Code = ${branch.branch_code}\n`);

        // 5. Actualizar employee con main_branch_id
        console.log(`📝 Actualizando employee.main_branch_id...`);
        await pool.query('UPDATE employees SET main_branch_id = $1 WHERE id = $2', [branch.id, employee.id]);
        console.log(`✅ Employee actualizado con main_branch_id = ${branch.id}\n`);

        // 6. Vincular employee a branch
        console.log(`📝 Vinculando employee a branch...`);
        await pool.query(`
            INSERT INTO employee_branches (employee_id, branch_id, can_login, can_sell, can_manage_inventory, can_close_shift)
            VALUES ($1, $2, true, true, true, true)
        `, [employee.id, branch.id]);
        console.log(`✅ Vinculación creada\n`);

        // 7. Verificar datos
        console.log('📊 VERIFICACIÓN FINAL:\n');

        const verifyTenant = await pool.query('SELECT * FROM tenants WHERE id = $1', [tenant.id]);
        console.log('Tenant:', verifyTenant.rows[0]);

        const verifyEmployee = await pool.query('SELECT id, tenant_id, username, main_branch_id FROM employees WHERE id = $1', [employee.id]);
        console.log('\nEmployee:', verifyEmployee.rows[0]);

        const verifyBranch = await pool.query('SELECT * FROM branches WHERE id = $1', [branch.id]);
        console.log('\nBranch:', verifyBranch.rows[0]);

        const verifyEmpBranch = await pool.query('SELECT * FROM employee_branches WHERE employee_id = $1', [employee.id]);
        console.log('\nEmployee_Branches:', verifyEmpBranch.rows[0]);

        console.log('\n\n✅ ✅ ✅ PRUEBA EXITOSA ✅ ✅ ✅\n');
        console.log(`Tenant ID: ${tenant.id}`);
        console.log(`Employee ID: ${employee.id}`);
        console.log(`Branch ID: ${branch.id}`);

        // 8. Eliminar datos de prueba
        console.log('\n🗑️  Eliminando datos de prueba...');
        await pool.query('DELETE FROM employee_branches WHERE employee_id = $1', [employee.id]);
        await pool.query('DELETE FROM employees WHERE id = $1', [employee.id]);
        await pool.query('DELETE FROM branches WHERE id = $1', [branch.id]);
        await pool.query('DELETE FROM tenants WHERE id = $1', [tenant.id]);
        console.log('✅ Datos eliminados\n');

    } catch (error) {
        console.error('\n❌ ERROR:', error.message);
        console.error('Detalles:', error);
    } finally {
        await pool.end();
    }
}

testDirectInsert();
