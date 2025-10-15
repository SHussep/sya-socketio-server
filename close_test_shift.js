const { Pool } = require('pg');

const pool = new Pool({
  host: 'dpg-d3i8dv3e5dus738tm5rg-a.oregon-postgres.render.com',
  port: 5432,
  user: 'sya_admin',
  password: 'qJ1haIaPp7m7OFMyicWSplPlGoNL1GpF',
  database: 'sya_db_oe4v',
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
