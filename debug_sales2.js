const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

(async () => {
  try {
    // ALL ventas in the database
    const allVentas = await pool.query(`
      SELECT COUNT(*) as total,
             MIN(created_at) as primera,
             MAX(created_at) as ultima,
             SUM(total)::numeric as monto_total
      FROM ventas
    `);
    console.log('=== TODAS LAS VENTAS EN PG ===');
    console.log(JSON.stringify(allVentas.rows[0], null, 2));

    // All ventas by branch
    const byBranch = await pool.query(`
      SELECT v.branch_id, b.name as branch_name,
             COUNT(*) as num_ventas, SUM(v.total)::numeric as total
      FROM ventas v
      LEFT JOIN branches b ON v.branch_id = b.id
      GROUP BY v.branch_id, b.name
    `);
    console.log('\n=== VENTAS POR BRANCH ===');
    byBranch.rows.forEach(r => console.log(JSON.stringify(r)));

    // Check ALL branches
    const branches = await pool.query(`SELECT id, name, tenant_id FROM branches ORDER BY id`);
    console.log('\n=== BRANCHES ===');
    branches.rows.forEach(r => console.log(JSON.stringify(r)));

    // Check dashboard endpoint query - how does Flutter get data?
    // Flutter calls /api/dashboard/summary which might use different date logic
    const dashRoute = await pool.query(`
      SELECT COUNT(*) as total_ventas,
             COALESCE(SUM(total), 0)::numeric as total_monto
      FROM ventas
      WHERE tenant_id = 1
      AND (created_at AT TIME ZONE 'America/Hermosillo')::date = (NOW() AT TIME ZONE 'America/Hermosillo')::date
    `);
    console.log('\n=== DASHBOARD TENANT 1 HOY ===');
    console.log(JSON.stringify(dashRoute.rows[0]));

    // Check if there are sales in the queue tables / sync tables
    const tables = await pool.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
      AND table_name ILIKE '%sale%' OR table_name ILIKE '%venta%' OR table_name ILIKE '%queue%'
      ORDER BY table_name
    `);
    console.log('\n=== TABLAS RELACIONADAS ===');
    tables.rows.forEach(r => console.log(r.table_name));

    // Check if Flutter ventas are going to a different table or have sync issues
    // Check any ventas with global_id (offline-first pattern)
    const withGlobalId = await pool.query(`
      SELECT COUNT(*) as total,
             COUNT(global_id) as con_global_id,
             COUNT(*) - COUNT(global_id) as sin_global_id
      FROM ventas
    `);
    console.log('\n=== VENTAS CON/SIN GLOBAL_ID ===');
    console.log(JSON.stringify(withGlobalId.rows[0]));

    // Active shifts right now
    const activeShifts = await pool.query(`
      SELECT s.id, s.global_id, s.employee_id, e.name as employee_name,
             s.terminal_id, s.is_cash_cut_open, s.branch_id,
             b.name as branch_name, s.created_at
      FROM shifts s
      LEFT JOIN employees e ON s.employee_id = e.id
      LEFT JOIN branches b ON s.branch_id = b.id
      WHERE s.is_cash_cut_open = true
      ORDER BY s.created_at DESC
    `);
    console.log('\n=== TURNOS ACTIVOS ===');
    activeShifts.rows.forEach(r => console.log(JSON.stringify(r)));

    await pool.end();
  } catch(e) {
    console.error('Error:', e.message);
    await pool.end();
  }
})();
