require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function checkStructure() {
  try {
    console.log('='.repeat(60));
    console.log('CHECKING VENTAS TABLES');
    console.log('='.repeat(60));

    // Check if ventas table exists
    const ventasCheck = await pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      AND table_name IN ('ventas', 'ventas_detalle')
      ORDER BY table_name
    `);

    console.log('\n📊 VENTAS TABLES FOUND:');
    ventasCheck.rows.forEach(row => console.log(`  ✅ ${row.table_name}`));

    if (ventasCheck.rows.length === 0) {
      console.log('  ❌ NO VENTAS TABLES FOUND');
      pool.end();
      return;
    }

    // Get ventas table structure
    if (ventasCheck.rows.some(r => r.table_name === 'ventas')) {
      console.log('\n📋 VENTAS TABLE COLUMNS:');
      const ventasColumns = await pool.query(`
        SELECT column_name, data_type, character_maximum_length, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_name = 'ventas'
        ORDER BY ordinal_position
      `);

      ventasColumns.rows.forEach(col => {
        const nullable = col.is_nullable === 'YES' ? 'NULL' : 'NOT NULL';
        const length = col.character_maximum_length ? `(${col.character_maximum_length})` : '';
        const def = col.column_default ? ` DEFAULT ${col.column_default.substring(0, 30)}` : '';
        console.log(`  ${col.column_name.padEnd(25)} ${col.data_type}${length.padEnd(10)} ${nullable}${def}`);
      });
    }

    // Get ventas_detalle table structure
    if (ventasCheck.rows.some(r => r.table_name === 'ventas_detalle')) {
      console.log('\n📋 VENTAS_DETALLE TABLE COLUMNS:');
      const detalleColumns = await pool.query(`
        SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
        WHERE table_name = 'ventas_detalle'
        ORDER BY ordinal_position
      `);

      detalleColumns.rows.forEach(col => {
        const nullable = col.is_nullable === 'YES' ? 'NULL' : 'NOT NULL';
        console.log(`  ${col.column_name.padEnd(30)} ${col.data_type.padEnd(15)} ${nullable}`);
      });
    }

    // Check indexes
    console.log('\n📑 VENTAS INDEXES:');
    const indexes = await pool.query(`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE tablename IN ('ventas', 'ventas_detalle')
      ORDER BY indexname
    `);

    indexes.rows.forEach(idx => {
      console.log(`\n  ${idx.indexname}:`);
      console.log(`    ${idx.indexdef}`);
    });

    pool.end();
  } catch (error) {
    console.error('❌ Error:', error.message);
    pool.end();
  }
}

checkStructure();
