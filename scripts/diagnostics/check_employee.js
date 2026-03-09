// Script para verificar un empleado específico en la BD
// Uso: node check_employee.js <email>

const { pool } = require('./database');

async function checkEmployee(email) {
    try {
        console.log(`\n🔍 Buscando empleado con email: ${email}\n`);

        const result = await pool.query(
            `SELECT id, tenant_id, email, username, first_name, last_name,
                    password_hash, is_active, role_id, created_at
             FROM employees
             WHERE LOWER(email) = LOWER($1)`,
            [email]
        );

        if (result.rows.length === 0) {
            console.log('❌ No se encontró ningún empleado con ese email\n');
            process.exit(1);
        }

        console.log(`✅ Empleados encontrados: ${result.rows.length}\n`);
        console.log('═'.repeat(100));

        result.rows.forEach((emp, index) => {
            console.log(`\n${index + 1}. Empleado ID: ${emp.id}`);
            console.log(`   Tenant ID:    ${emp.tenant_id}`);
            console.log(`   Email:        ${emp.email}`);
            console.log(`   Username:     ${emp.username || 'N/A'}`);
            console.log(`   Nombre:       ${emp.first_name} ${emp.last_name}`);
            console.log(`   Role ID:      ${emp.role_id || 'N/A'}`);
            console.log(`   Activo:       ${emp.is_active ? '✅' : '❌'}`);
            console.log(`   Creado:       ${emp.created_at}`);
            console.log(`   Password:     ${emp.password_hash ? '✅ EXISTS' : '❌ NULL'}`);

            if (emp.password_hash) {
                console.log(`   Password length: ${emp.password_hash.length}`);
                console.log(`   Password format: ${emp.password_hash.startsWith('$2') ? 'bcrypt ✅' : 'unknown ⚠️'}`);
            }
        });

        console.log('\n' + '═'.repeat(100) + '\n');

        // Verificar si es activo
        const activeEmployee = result.rows.find(e => e.is_active);
        if (activeEmployee && activeEmployee.password_hash) {
            console.log('✅ Empleado activo con password encontrado - Login debería funcionar\n');
        } else if (activeEmployee && !activeEmployee.password_hash) {
            console.log('⚠️  Empleado activo PERO sin password - Necesita configurar password\n');
        }

        process.exit(0);
    } catch (error) {
        console.error('❌ Error:', error.message);
        process.exit(1);
    }
}

// Validar argumentos
const args = process.argv.slice(2);
if (args.length !== 1) {
    console.log('\n❌ Uso incorrecto\n');
    console.log('Uso: node check_employee.js <email>\n');
    console.log('Ejemplo:');
    console.log('  node check_employee.js saul.hussep@gmail.com\n');
    process.exit(1);
}

const [email] = args;

// Ejecutar
checkEmployee(email);
