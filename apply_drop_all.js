const { Pool } = require('pg');
const fs = require('fs');

const pool = new Pool({
  host: 'dpg-d3i8dv3e5dus738tm5rg-a.oregon-postgres.render.com',
  user: 'sya_admin',
  password: 'qJ1haIaPp7m7OFMyicWSplPlGoNL1GpF',
  database: 'sya_db_oe4v',
  port: 5432,
  ssl: { rejectUnauthorized: false }
});

async function dropAll() {
  try {
    console.log('🗑️  Eliminando todas las tablas...\n');

    const sql = fs.readFileSync('C:/SYA/sya-socketio-server/migrations/000_drop_all_tables.sql', 'utf8');

    await pool.query(sql);

    console.log('✅ Todas las tablas eliminadas exitosamente\n');

    // Verificar que no quede nada
    const { rows } = await pool.query(`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
      ORDER BY tablename;
    `);

    console.log(`📋 Tablas restantes en la base de datos: ${rows.length}`);
    if (rows.length > 0) {
      rows.forEach(row => console.log(`   - ${row.tablename}`));
    } else {
      console.log('   (ninguna - base de datos limpia)');
    }

    pool.end();
  } catch (error) {
    console.error('❌ Error:', error.message);
    pool.end();
    process.exit(1);
  }
}

dropAll();
