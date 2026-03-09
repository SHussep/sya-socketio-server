const { pool } = require('./database');
require('dotenv').config();

(async () => {
  try {
    const client = await pool.connect();
    const result = await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`);

    console.log('\n📋 Tablas en la BD:\n');
    result.rows.forEach(r => console.log('  - ' + r.table_name));

    client.release();
    process.exit(0);
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  }
})();
