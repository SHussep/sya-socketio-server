require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function checkBackupTable() {
  try {
    console.log('🔍 Verificando estructura de backup_metadata...\n');

    // Get columns with nullable info
    const result = await pool.query(`
      SELECT
        column_name,
        data_type,
        is_nullable,
        column_default
      FROM information_schema.columns
      WHERE table_name = 'backup_metadata'
      ORDER BY ordinal_position;
    `);

    console.log('📊 Estructura de backup_metadata:\n');
    result.rows.forEach(col => {
      const nullable = col.is_nullable === 'YES' ? '✓ NULL' : '✗ NOT NULL';
      const defaultVal = col.column_default ? ` (default: ${col.column_default})` : '';
      console.log(`   ${col.column_name.padEnd(25)} ${col.data_type.padEnd(20)} ${nullable}${defaultVal}`);
    });

    // Check if there are any records
    const countResult = await pool.query('SELECT COUNT(*) FROM backup_metadata');
    console.log(`\n📦 Registros existentes: ${countResult.rows[0].count}`);

    // Check tenants
    const tenantsResult = await pool.query('SELECT id, tenant_code, business_name FROM tenants ORDER BY id LIMIT 5');
    console.log(`\n👥 Primeros 5 tenants:\n`);
    tenantsResult.rows.forEach(t => {
      console.log(`   ID: ${t.id} - ${t.tenant_code} - ${t.business_name}`);
    });

    await pool.end();
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

checkBackupTable();
