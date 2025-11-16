// Script para listar empleados sin contraseña configurada
// Uso: node list_employees_without_password.js

const { pool } = require('./database');

async function listEmployeesWithoutPassword() {
    try {
        const result = await pool.query(
            `SELECT
                e.id,
                e.email,
                e.username,
                e.first_name,
                e.last_name,
                e.role_id,
                e.is_active,
                t.business_name as tenant_name
             FROM employees e
             LEFT JOIN tenants t ON e.tenant_id = t.id
             WHERE e.password_hash IS NULL OR e.password_hash = ''
             ORDER BY e.is_active DESC, e.created_at DESC`
        );

        if (result.rows.length === 0) {
            console.log('\n✅ Todos los empleados tienen contraseña configurada\n');
            process.exit(0);
        }

        console.log(`\n⚠️  Empleados sin contraseña: ${result.rows.length}\n`);
        console.log('═'.repeat(100));

        result.rows.forEach((emp, index) => {
            console.log(`\n${index + 1}. ${emp.first_name} ${emp.last_name}`);
            console.log(`   ID:       ${emp.id}`);
            console.log(`   Email:    ${emp.email || 'N/A'}`);
            console.log(`   Username: ${emp.username || 'N/A'}`);
            console.log(`   Role ID:  ${emp.role_id || 'N/A'}`);
            console.log(`   Tenant:   ${emp.tenant_name || 'N/A'}`);
            console.log(`   Activo:   ${emp.is_active ? '✅' : '❌'}`);
        });

        console.log('\n' + '═'.repeat(100));
        console.log(`\n💡 Para establecer contraseña a un empleado, ejecuta:`);
        console.log(`   node set_employee_password.js <email_o_username> <nueva_contraseña>\n`);
        console.log(`Ejemplo:`);
        console.log(`   node set_employee_password.js ${result.rows[0].email || result.rows[0].username} Password123\n`);

        process.exit(0);
    } catch (error) {
        console.error('❌ Error:', error.message);
        process.exit(1);
    }
}

// Ejecutar
listEmployeesWithoutPassword();
