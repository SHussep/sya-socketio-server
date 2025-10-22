#!/usr/bin/env node

const { pool } = require('./database');
require('dotenv').config();

async function checkTable() {
  try {
    const result = await pool.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'repartidor_debts'
      ORDER BY ordinal_position;
    `);

    console.log('📋 Estructura de tabla repartidor_debts:');
    console.log('─'.repeat(80));

    result.rows.forEach(row => {
      console.log(`  ${row.column_name.padEnd(20)} | ${row.data_type.padEnd(15)} | ${row.is_nullable}`);
    });

    console.log('\n✅ Columnas encontradas:', result.rows.map(r => r.column_name).join(', '));

    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

checkTable();
