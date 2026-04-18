const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

(async () => {
  try {
    const BID = 47;
    const TID = 41;

    // Two active shifts - what does each one have?
    console.log('=== TURNO 650 (employee 123) ventas hoy ===');
    const t650 = await pool.query(`
      SELECT id_venta, total, created_at, ticket_number
      FROM ventas
      WHERE id_turno = 650
      AND (created_at AT TIME ZONE 'America/Hermosillo')::date = (NOW() AT TIME ZONE 'America/Hermosillo')::date
      ORDER BY created_at
    `);
    let sum650 = 0;
    t650.rows.forEach(r => { sum650 += parseFloat(r.total); console.log('$' + r.total, '| ticket:', r.ticket_number, '| created:', r.created_at); });
    console.log('TOTAL turno 650:', sum650);

    console.log('\n=== TURNO 651 (employee 132) ventas hoy ===');
    const t651 = await pool.query(`
      SELECT id_venta, total, created_at, ticket_number
      FROM ventas
      WHERE id_turno = 651
      AND (created_at AT TIME ZONE 'America/Hermosillo')::date = (NOW() AT TIME ZONE 'America/Hermosillo')::date
      ORDER BY created_at
    `);
    let sum651 = 0;
    t651.rows.forEach(r => { sum651 += parseFloat(r.total); console.log('$' + r.total, '| ticket:', r.ticket_number, '| created:', r.created_at); });
    console.log('TOTAL turno 651:', sum651);

    // Check what Desktop's dashboard queries
    // Desktop likely uses /api/dashboard/summary or queries its local SQLite
    // Let's check the dashboard route
    console.log('\n=== CHECKING DASHBOARD ENDPOINT QUERY PATTERN ===');

    // Desktop shows $582. Let's find which combination of sales = $582
    const allToday = await pool.query(`
      SELECT id_venta, total, id_turno, ticket_number, created_at, global_id
      FROM ventas
      WHERE branch_id = $1
      AND (created_at AT TIME ZONE 'America/Hermosillo')::date = (NOW() AT TIME ZONE 'America/Hermosillo')::date
      ORDER BY created_at
    `, [BID]);

    // Try to find subset summing to $582
    let runningSum = 0;
    console.log('\n=== RUNNING SUM TO FIND $582 ===');
    for (const r of allToday.rows) {
      runningSum += parseFloat(r.total);
      console.log('+ $' + r.total, '= $' + runningSum, '(turno:', r.id_turno + ', ticket:', r.ticket_number + ')');
      if (Math.abs(runningSum - 582) < 0.01) {
        console.log('>>> FOUND $582 at id_venta', r.id_venta);
      }
    }

    // Also check: maybe Desktop uses a different "today" definition
    // Windows local time might be different from Hermosillo
    console.log('\n=== IF DESKTOP USES UTC FOR "TODAY" (00:00-23:59 UTC) ===');
    const utcToday = await pool.query(`
      SELECT COUNT(*) as total_ventas, COALESCE(SUM(total), 0)::numeric as total_monto
      FROM ventas WHERE branch_id = $1
      AND created_at::date = CURRENT_DATE
    `, [BID]);
    console.log(JSON.stringify(utcToday.rows[0]));

    // Maybe Desktop uses MST (UTC-7) but with a different cutoff?
    console.log('\n=== VENTAS ENTRE 07:00 UTC y 11:00 UTC (Hermosillo midnight to 4am) ===');
    const earlyToday = await pool.query(`
      SELECT COUNT(*) as total_ventas, COALESCE(SUM(total), 0)::numeric as total_monto
      FROM ventas WHERE branch_id = $1
      AND created_at >= '2026-03-25T07:00:00Z'
    `, [BID]);
    console.log(JSON.stringify(earlyToday.rows[0]));

    // Check Desktop's dashboard API - does it exist?
    console.log('\n=== DEPOSITS/WITHDRAWALS HOY ===');
    const deps = await pool.query(`
      SELECT COUNT(*) as total, COALESCE(SUM(amount), 0)::numeric as monto
      FROM deposits WHERE branch_id = $1
      AND (created_at AT TIME ZONE 'America/Hermosillo')::date = (NOW() AT TIME ZONE 'America/Hermosillo')::date
    `, [BID]);
    console.log('Deposits:', JSON.stringify(deps.rows[0]));

    const wdrs = await pool.query(`
      SELECT COUNT(*) as total, COALESCE(SUM(amount), 0)::numeric as monto
      FROM withdrawals WHERE branch_id = $1
      AND (created_at AT TIME ZONE 'America/Hermosillo')::date = (NOW() AT TIME ZONE 'America/Hermosillo')::date
    `, [BID]);
    console.log('Withdrawals:', JSON.stringify(wdrs.rows[0]));

    await pool.end();
  } catch(e) {
    console.error('Error:', e.message);
    await pool.end();
  }
})();
