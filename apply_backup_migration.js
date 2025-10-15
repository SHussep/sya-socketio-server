const { Pool } = require('pg');
const fs = require('fs');

const pool = new Pool({
  connectionString: 'postgresql://sya_admin:qJ1haIaPp7m7OFMyicWSplPlGoNL1GpF@dpg-d3i8dv3e5dus738tm5rg-a.oregon-postgres.render.com/sya_db_oe4v',
  ssl: { rejectUnauthorized: false }
});

async function applyMigration() {
  try {
    console.log('📦 Aplicando migración 002: backup_metadata...\n');

    // Leer el archivo de migración
    const migrationSQL = fs.readFileSync('./migrations/002_add_backup_metadata.sql', 'utf8');

    // Ejecutar la migración
    await pool.query(migrationSQL);

    console.log('✅ Migración aplicada exitosamente\n');

    // Verificar que la tabla existe
    const result = await pool.query(`
      SELECT tablename
      FROM pg_tables
      WHERE schemaname = 'public'
      ORDER BY tablename;
    `);

    console.log(`📋 Total de tablas: ${result.rows.length}\n`);

    result.rows.forEach((row, index) => {
      console.log(`   ${(index + 1).toString().padStart(2)}. ${row.tablename}`);
    });

    await pool.end();
  } catch (error) {
    console.error('❌ Error al aplicar migración:', error.message);
    process.exit(1);
  }
}

applyMigration();
