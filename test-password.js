const bcrypt = require('bcryptjs');
const { pool } = require('./database.js');

(async () => {
  try {
    const result = await pool.query(
      'SELECT password FROM employees WHERE username = $1',
      ['saulhussep']
    );

    if (result.rows.length > 0) {
      const hash = result.rows[0].password;
      console.log('Hash en BD:', hash.substring(0, 30) + '...');

      const isValid = await bcrypt.compare('1234', hash);
      console.log('✅ Password "1234" es válida:', isValid);
    } else {
      console.log('❌ Usuario no encontrado');
    }
  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await pool.end();
  }
})();
