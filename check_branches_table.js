require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function checkBranches() {
  try {
    const { rows: columns } = await pool.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'branches'
      ORDER BY ordinal_position;
    `);

    console.log('Columnas en tabla branches:');
    columns.forEach(col => {
      console.log(`  ${col.column_name.padEnd(30)} ${col.data_type}`);
    });

    const { rows: employees } = await pool.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'employees'
      ORDER BY ordinal_position;
    `);

    console.log('\nColumnas en tabla employees:');
    employees.forEach(col => {
      console.log(`  ${col.column_name.padEnd(30)} ${col.data_type}`);
    });

    pool.end();
  } catch (error) {
    console.error('Error:', error.message);
    pool.end();
  }
}

checkBranches();
