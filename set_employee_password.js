// Script para establecer contraseña a empleados sin contraseña configurada
// Uso: node set_employee_password.js <email_o_username> <nueva_contraseña>

const bcrypt = require('bcryptjs');
const { pool } = require('./database');

async function setEmployeePassword(emailOrUsername, newPassword) {
    try {
        // Buscar empleado
        const employeeResult = await pool.query(
            `SELECT id, email, username, first_name, last_name, password
             FROM employees
             WHERE LOWER(email) = LOWER($1) OR LOWER(username) = LOWER($1)`,
            [emailOrUsername]
        );

        if (employeeResult.rows.length === 0) {
            console.log(`❌ No se encontró empleado con email/username: ${emailOrUsername}`);
            process.exit(1);
        }

        const employee = employeeResult.rows[0];
        console.log(`\n📋 Empleado encontrado:`);
        console.log(`   ID: ${employee.id}`);
        console.log(`   Nombre: ${employee.first_name} ${employee.last_name}`);
        console.log(`   Email: ${employee.email}`);
        console.log(`   Username: ${employee.username}`);
        console.log(`   Tiene contraseña: ${employee.password ? '✅ Sí' : '❌ No'}\n`);

        // Hash de la nueva contraseña
        const hashedPassword = await bcrypt.hash(newPassword, 10);

        // Actualizar en base de datos
        await pool.query(
            `UPDATE employees
             SET password = $1, updated_at = NOW()
             WHERE id = $2`,
            [hashedPassword, employee.id]
        );

        console.log(`✅ Contraseña actualizada exitosamente para ${employee.email}`);
        console.log(`   Nueva contraseña: ${newPassword}`);
        console.log(`\n💡 Ahora puedes iniciar sesión con:`);
        console.log(`   Email: ${employee.email}`);
        console.log(`   Username: ${employee.username}`);
        console.log(`   Contraseña: ${newPassword}\n`);

        process.exit(0);
    } catch (error) {
        console.error('❌ Error:', error.message);
        process.exit(1);
    }
}

// Validar argumentos
const args = process.argv.slice(2);
if (args.length !== 2) {
    console.log('\n❌ Uso incorrecto\n');
    console.log('Uso: node set_employee_password.js <email_o_username> <nueva_contraseña>\n');
    console.log('Ejemplo:');
    console.log('  node set_employee_password.js juan.martinez@example.com MiPassword123\n');
    process.exit(1);
}

const [emailOrUsername, newPassword] = args;

// Ejecutar
setEmployeePassword(emailOrUsername, newPassword);
