require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function closeShift() {
  try {
    const result = await pool.query(
      `UPDATE shifts SET is_cash_cut_open = false WHERE id = 4 RETURNING id, is_cash_cut_open`
    );
    console.log('✅ Turno cerrado:', result.rows[0]);
    await pool.end();
  } catch (error) {
    console.error('❌ Error:', error.message);
    await pool.end();
  }
}

closeShift();
