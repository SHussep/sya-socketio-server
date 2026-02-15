require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function checkStructure() {
  try {
    console.log('='.repeat(60));
    console.log('CHECKING TABLE STRUCTURES');
    console.log('='.repeat(60));

    // Check for sales tables
    const salesTables = await pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      AND table_name LIKE '%sale%'
      ORDER BY table_name
    `);

    console.log('\n📊 SALES-RELATED TABLES:');
    salesTables.rows.forEach(row => console.log(`  - ${row.table_name}`));

    // Get sales table structure
    if (salesTables.rows.some(r => r.table_name === 'sales')) {
      console.log('\n📋 SALES TABLE COLUMNS:');
      const salesColumns = await pool.query(`
        SELECT column_name, data_type, character_maximum_length, is_nullable
        FROM information_schema.columns
        WHERE table_name = 'sales'
        ORDER BY ordinal_position
      `);

      salesColumns.rows.forEach(col => {
        const nullable = col.is_nullable === 'YES' ? 'NULL' : 'NOT NULL';
        const length = col.character_maximum_length ? `(${col.character_maximum_length})` : '';
        console.log(`  ${col.column_name.padEnd(25)} ${col.data_type}${length} ${nullable}`);
      });
    }

    // Check if sale_items or sales_items exist
    const itemTables = salesTables.rows.filter(r => r.table_name.includes('item'));
    if (itemTables.length > 0) {
      console.log('\n⚠️  MULTIPLE ITEM TABLES FOUND:');
      for (const table of itemTables) {
        console.log(`\n  📋 ${table.table_name.toUpperCase()} COLUMNS:`);
        const columns = await pool.query(`
          SELECT column_name, data_type
          FROM information_schema.columns
          WHERE table_name = $1
          ORDER BY ordinal_position
        `, [table.table_name]);

        columns.rows.forEach(col => {
          console.log(`    - ${col.column_name} (${col.data_type})`);
        });
      }
    }

    pool.end();
  } catch (error) {
    console.error('❌ Error:', error.message);
    pool.end();
  }
}

checkStructure();
