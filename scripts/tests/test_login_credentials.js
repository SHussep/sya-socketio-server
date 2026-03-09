const pg = require('pg');
const bcrypt = require('bcryptjs');

const pool = new pg.Pool({
  user: 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'sya_db'
});

async function testCredentials() {
  const email = 'entretierras.podcast@gmail.com';
  const password = 'tu_contraseña_aqui'; // Cambiar por la contraseña real

  console.log('\n=== Test de Credenciales ===\n');
  console.log(`Email: ${email}`);

  try {
    // 1. Buscar empleado
    const employeeResult = await pool.query(
      'SELECT id, email, username, full_name, is_active, password FROM employees WHERE LOWER(email) = LOWER($1)',
      [email]
    );

    if (employeeResult.rows.length === 0) {
      console.log('\n❌ Empleado NO encontrado en la base de datos');
      return;
    }

    const employee = employeeResult.rows[0];
    console.log('\n✅ Empleado encontrado:');
    console.log(`   - ID: ${employee.id}`);
    console.log(`   - Email: ${employee.email}`);
    console.log(`   - Username: ${employee.username}`);
    console.log(`   - Nombre: ${employee.full_name}`);
    console.log(`   - Activo: ${employee.is_active ? 'Sí' : 'NO - INACTIVO'}`);
    console.log(`   - Contraseña almacenada: ${employee.password.substring(0, 20)}...`);

    if (!employee.is_active) {
      console.log('\n⚠️  PROBLEMA: El empleado está INACTIVO. No puede iniciar sesión.');
      return;
    }

    // 2. Validar contraseña
    if (!employee.password) {
      console.log('\n❌ ERROR: El empleado no tiene contraseña almacenada');
      return;
    }

    console.log('\n🔐 Verificando contraseña...');
    const isPasswordValid = await bcrypt.compare(password, employee.password);

    if (isPasswordValid) {
      console.log('✅ Contraseña CORRECTA');
    } else {
      console.log('❌ Contraseña INCORRECTA');
    }

    // 3. Verificar ramas y permisos
    const branchesResult = await pool.query(`
      SELECT b.id, b.code, b.name, eb.role
      FROM branches b
      LEFT JOIN employee_branches eb ON b.id = eb.branch_id AND eb.employee_id = $1
      ORDER BY b.id
    `, [employee.id]);

    console.log('\n📍 Sucursales disponibles:');
    if (branchesResult.rows.length === 0) {
      console.log('   ❌ Sin acceso a ninguna sucursal');
    } else {
      branchesResult.rows.forEach(branch => {
        console.log(`   - ${branch.code} (${branch.name}) - Rol: ${branch.role || 'N/A'}`);
      });
    }

  } catch (error) {
    console.error('\n❌ Error en la base de datos:', error.message);
  } finally {
    await pool.end();
  }
}

testCredentials();
