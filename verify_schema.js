const { Pool } = require('pg');

const pool = new Pool({
  connectionString: 'postgresql://sya_admin:qJ1haIaPp7m7OFMyicWSplPlGoNL1GpF@dpg-d3i8dv3e5dus738tm5rg-a.oregon-postgres.render.com/sya_db_oe4v',
  ssl: { rejectUnauthorized: false }
});

async function verifySchema() {
  try {
    console.log('🔍 Verificando esquema de PostgreSQL...\n');

    // Get all tables
    const tablesResult = await pool.query(`
      SELECT tablename
      FROM pg_tables
      WHERE schemaname = 'public'
      ORDER BY tablename;
    `);

    console.log(`📋 Total de tablas: ${tablesResult.rows.length}\n`);

    tablesResult.rows.forEach((row, index) => {
      console.log(`   ${(index + 1).toString().padStart(2)}. ${row.tablename}`);
    });

    console.log('\n' + '='.repeat(60));

    // Check if backup_metadata exists
    const backupTable = tablesResult.rows.find(r => r.tablename === 'backup_metadata');

    if (backupTable) {
      console.log('\n✅ Tabla backup_metadata existe');

      // Get columns
      const columnsResult = await pool.query(`
        SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_name = 'backup_metadata'
        ORDER BY ordinal_position;
      `);

      console.log('\n📊 Estructura de backup_metadata:');
      columnsResult.rows.forEach(col => {
        console.log(`   - ${col.column_name} (${col.data_type}) ${col.is_nullable === 'NO' ? 'NOT NULL' : 'NULL'}`);
      });
    } else {
      console.log('\n❌ Tabla backup_metadata NO existe');
    }

    await pool.end();
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

verifySchema();
