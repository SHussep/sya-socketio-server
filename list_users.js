const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function listUsers() {
  const client = await pool.connect();

  try {
    console.log('📋 Listando usuarios en la base de datos...\n');

    // Listar tenants
    const tenants = await client.query('SELECT * FROM tenants');
    console.log('TENANTS:');
    console.log(tenants.rows);
    console.log('');

    // Listar employees
    const employees = await client.query('SELECT id, tenant_id, username, email, full_name, role, is_active FROM employees');
    console.log('EMPLOYEES:');
    console.log(employees.rows);
    console.log('');

    // Intentar login con password hasheado
    const bcrypt = require('bcrypt');
    for (const emp of employees.rows) {
      console.log(`\nUsuario: ${emp.username} (${emp.email})`);

      // Obtener password hash
      const passResult = await client.query('SELECT password FROM employees WHERE id = $1', [emp.id]);
      const storedHash = passResult.rows[0].password;

      console.log(`  Password hash: ${storedHash.substring(0, 20)}...`);

      // Probar contraseñas comunes
      const passwords = ['1234', '1212'];
      for (const pass of passwords) {
        const matches = await bcrypt.compare(pass, storedHash);
        console.log(`  Password "${pass}": ${matches ? '✅ CORRECTO' : '❌ Incorrecto'}`);
      }
    }

  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    client.release();
    await pool.end();
  }
}

listUsers()
  .then(() => process.exit(0))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
