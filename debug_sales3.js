const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

(async () => {
  try {
    // Branch 47 = SYA Tortillerias - Principal
    const BID = 47;
    const TID = 41;

    // Ventas hoy branch 47
    const today = await pool.query(`
      SELECT COUNT(*) as total_ventas,
             COALESCE(SUM(total), 0)::numeric as total_monto
      FROM ventas
      WHERE branch_id = $1
      AND (created_at AT TIME ZONE 'America/Hermosillo')::date = (NOW() AT TIME ZONE 'America/Hermosillo')::date
    `, [BID]);
    console.log('=== VENTAS HOY BRANCH 47 (SYA Tortillerias) ===');
    console.log(JSON.stringify(today.rows[0]));

    // Ultimas 20 ventas branch 47
    const recent = await pool.query(`
      SELECT id_venta, total, created_at, id_turno, ticket_number,
             tipo_pago_id, global_id
      FROM ventas
      WHERE branch_id = $1
      ORDER BY created_at DESC
      LIMIT 20
    `, [BID]);
    console.log('\n=== ULTIMAS 20 VENTAS BRANCH 47 ===');
    recent.rows.forEach(r => console.log(
      'id:', r.id_venta,
      '| $' + r.total,
      '| turno:', r.id_turno,
      '| ticket:', r.ticket_number,
      '| pago:', r.tipo_pago_id,
      '| created:', r.created_at
    ));

    // Ventas por dia branch 47
    const byDay = await pool.query(`
      SELECT (created_at AT TIME ZONE 'America/Hermosillo')::date as dia,
             COUNT(*) as num_ventas,
             SUM(total)::numeric as total
      FROM ventas
      WHERE branch_id = $1
      GROUP BY dia
      ORDER BY dia DESC
      LIMIT 10
    `, [BID]);
    console.log('\n=== VENTAS POR DIA BRANCH 47 ===');
    byDay.rows.forEach(r => console.log(JSON.stringify(r)));

    // Active shifts for tenant 41
    const shifts = await pool.query(`
      SELECT s.id, s.global_id, s.employee_id, s.terminal_id,
             s.is_cash_cut_open, s.branch_id, s.created_at, s.initial_amount
      FROM shifts s
      WHERE s.tenant_id = $1
      ORDER BY s.created_at DESC
      LIMIT 10
    `, [TID]);
    console.log('\n=== TURNOS RECIENTES TENANT 41 ===');
    shifts.rows.forEach(r => console.log(JSON.stringify(r)));

    // Dashboard API endpoint query simulation
    // Check what the /api/dashboard/summary endpoint does
    const dashSummary = await pool.query(`
      SELECT
        COALESCE(SUM(total), 0)::numeric as ventas_total,
        COUNT(*) as ventas_count
      FROM ventas
      WHERE tenant_id = $1
      AND branch_id = $2
      AND (created_at AT TIME ZONE 'America/Hermosillo')::date = (NOW() AT TIME ZONE 'America/Hermosillo')::date
    `, [TID, BID]);
    console.log('\n=== DASHBOARD SIMULATION (tenant 41, branch 47, hoy) ===');
    console.log(JSON.stringify(dashSummary.rows[0]));

    // Check if ventas exist but maybe with wrong timezone interpretation
    const ventasLast24h = await pool.query(`
      SELECT COUNT(*) as total, SUM(total)::numeric as monto
      FROM ventas
      WHERE branch_id = $1
      AND created_at > NOW() - INTERVAL '24 hours'
    `, [BID]);
    console.log('\n=== VENTAS ULTIMAS 24H ===');
    console.log(JSON.stringify(ventasLast24h.rows[0]));

    await pool.end();
  } catch(e) {
    console.error('Error:', e.message);
    await pool.end();
  }
})();
