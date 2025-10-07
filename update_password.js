const bcrypt = require('bcrypt');
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function updatePassword() {
  const client = await pool.connect();

  try {
    console.log('🔐 Actualizando contraseña...');

    // Hashear password
    const hashedPassword = await bcrypt.hash('1234', 10);

    // Actualizar password del usuario
    const result = await client.query(`
      UPDATE employees
      SET password = $1
      WHERE email = 'saul.hussep@gmail.com'
      RETURNING id, email, username, full_name
    `, [hashedPassword]);

    if (result.rows.length > 0) {
      const user = result.rows[0];
      console.log('✅ Contraseña actualizada');
      console.log('');
      console.log('═══════════════════════════════════════════');
      console.log('  CREDENCIALES PARA LOGIN MÓVIL:');
      console.log('═══════════════════════════════════════════');
      console.log(`  Usuario: ${user.username}`);
      console.log(`  Email: ${user.email}`);
      console.log(`  Password: 1234`);
      console.log('═══════════════════════════════════════════');
    } else {
      console.log('❌ Usuario no encontrado');
    }

  } catch (error) {
    console.error('❌ Error:', error.message);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

updatePassword()
  .then(() => {
    console.log('\n✅ Proceso completado');
    process.exit(0);
  })
  .catch(err => {
    console.error('\n❌ Error:', err);
    process.exit(1);
  });
