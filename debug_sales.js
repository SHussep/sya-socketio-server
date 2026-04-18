const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

(async () => {
  try {
    // Current time on server vs local
    const time = await pool.query(`
      SELECT NOW() as utc_now,
             NOW() AT TIME ZONE 'America/Hermosillo' as hermosillo_now,
             CURRENT_DATE as utc_date,
             (NOW() AT TIME ZONE 'America/Hermosillo')::date as hermosillo_date
    `);
    console.log('=== TIEMPOS ===');
    console.log(JSON.stringify(time.rows[0], null, 2));
    console.log('Local JS time:', new Date().toISOString());

    // Ultimas 20 ventas del branch principal
    const recent = await pool.query(`
      SELECT id_venta, total, created_at, updated_at, id_turno, global_id, ticket_number
      FROM ventas
      WHERE branch_id = (SELECT id FROM branches WHERE name ILIKE '%principal%' LIMIT 1)
      ORDER BY created_at DESC
      LIMIT 20
    `);
    console.log('\n=== ULTIMAS 20 VENTAS ===');
    recent.rows.forEach(r => console.log(
      'id:', r.id_venta,
      '| total:', r.total,
      '| created:', r.created_at,
      '| turno:', r.id_turno,
      '| ticket:', r.ticket_number
    ));

    // Suma por dia
    const byDay = await pool.query(`
      SELECT (created_at AT TIME ZONE 'America/Hermosillo')::date as dia,
             COUNT(*) as num_ventas,
             SUM(total)::numeric as total
      FROM ventas
      WHERE branch_id = (SELECT id FROM branches WHERE name ILIKE '%principal%' LIMIT 1)
      AND created_at > NOW() - INTERVAL '3 days'
      GROUP BY dia
      ORDER BY dia DESC
    `);
    console.log('\n=== VENTAS ULTIMOS 3 DIAS ===');
    byDay.rows.forEach(r => console.log(JSON.stringify(r)));

    // Turnos de hoy
    const shifts = await pool.query(`
      SELECT id, global_id, employee_id, terminal_id, is_cash_cut_open,
             initial_amount, created_at
      FROM shifts
      WHERE branch_id = (SELECT id FROM branches WHERE name ILIKE '%principal%' LIMIT 1)
      AND created_at > NOW() - INTERVAL '2 days'
      ORDER BY created_at DESC
    `);
    console.log('\n=== TURNOS RECIENTES ===');
    shifts.rows.forEach(r => console.log(JSON.stringify(r)));

    // Dashboard query - lo que hace Flutter
    const branchId = await pool.query(`SELECT id FROM branches WHERE name ILIKE '%principal%' LIMIT 1`);
    const bid = branchId.rows[0]?.id;
    console.log('\nBranch Principal ID:', bid);

    // Simulate dashboard query with Hermosillo timezone
    const dashToday = await pool.query(`
      SELECT COUNT(*) as total_ventas,
             COALESCE(SUM(total), 0)::numeric as total_monto
      FROM ventas
      WHERE branch_id = $1
      AND (created_at AT TIME ZONE 'America/Hermosillo')::date = (NOW() AT TIME ZONE 'America/Hermosillo')::date
    `, [bid]);
    console.log('\n=== DASHBOARD HOY (Hermosillo TZ) ===');
    console.log(JSON.stringify(dashToday.rows[0]));

    await pool.end();
  } catch(e) {
    console.error('Error:', e.message);
    await pool.end();
  }
})();
