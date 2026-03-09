const pg = require('pg');

const pool = new pg.Pool({
  user: 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'sya_db'
});

async function listEmployees() {
  console.log('\n=== Lista de Empleados en la BD ===\n');

  try {
    const result = await pool.query(`
      SELECT
        id,
        email,
        username,
        full_name,
        is_active,
        CASE WHEN password IS NOT NULL THEN 'Sí' ELSE 'No' END as tiene_password
      FROM employees
      ORDER BY id
      LIMIT 20
    `);

    if (result.rows.length === 0) {
      console.log('❌ No hay empleados en la base de datos');
      return;
    }

    console.log(`✅ Total de empleados: ${result.rows.length}\n`);
    console.log('╔════╦════════════════════════════╦══════════╦════════════════╦════════╦════════════╗');
    console.log('║ ID ║ Email                      ║ Username ║ Nombre Completo║ Activo ║ Contraseña ║');
    console.log('╠════╬════════════════════════════╬══════════╬════════════════╬════════╬════════════╣');

    result.rows.forEach(emp => {
      const id = emp.id.toString().padEnd(2);
      const email = emp.email.substring(0, 26).padEnd(26);
      const username = (emp.username || 'N/A').substring(0, 8).padEnd(8);
      const fullname = (emp.full_name || 'N/A').substring(0, 12).padEnd(12);
      const active = emp.is_active ? 'Sí' : 'No';
      const password = emp.tiene_password;

      console.log(`║ ${id} ║ ${email} ║ ${username} ║ ${fullname} ║ ${active} ║ ${password.padEnd(8)} ║`);
    });

    console.log('╚════╩════════════════════════════╩══════════╩════════════════╩════════╩════════════╝');

    // Buscar específicamente el email del usuario
    const targetEmail = 'entretierras.podcast@gmail.com';
    const targetResult = await pool.query(
      'SELECT * FROM employees WHERE LOWER(email) = LOWER($1)',
      [targetEmail]
    );

    console.log(`\n📧 Búsqueda para: ${targetEmail}`);
    if (targetResult.rows.length > 0) {
      const emp = targetResult.rows[0];
      console.log(`✅ ENCONTRADO: ID ${emp.id} - ${emp.full_name} (Activo: ${emp.is_active})`);
    } else {
      console.log(`❌ NO ENCONTRADO en la base de datos`);
    }

  } catch (error) {
    console.error('\n❌ Error:', error.message);
  } finally {
    await pool.end();
  }
}

listEmployees();
