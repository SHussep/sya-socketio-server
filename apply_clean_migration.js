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

async function applyMigration() {
  try {
    console.log('📦 Aplicando migración limpia con estructura EXACTA de SQLite...\n');

    const sql = fs.readFileSync('C:/SYA/sya-socketio-server/migrations/001_create_base_schema.sql', 'utf8');

    await pool.query(sql);

    console.log('✅ Migración aplicada exitosamente\n');

    // Verificar tablas creadas
    const { rows } = await pool.query(`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
      ORDER BY tablename;
    `);

    console.log(`📋 Tablas creadas: ${rows.length}`);
    rows.forEach(row => console.log(`   - ${row.tablename}`));

    pool.end();
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
    pool.end();
    process.exit(1);
  }
}

applyMigration();
