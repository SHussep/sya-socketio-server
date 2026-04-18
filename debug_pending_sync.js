const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

(async () => {
  try {
    const BID = 47;
    const TID = 41;

    // 1. Total de asignaciones en PostgreSQL para esta branch
    const totalAssignments = await pool.query(`
      SELECT COUNT(*) as total,
             COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending,
             COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed,
             COUNT(CASE WHEN status = 'cancelled' THEN 1 END) as cancelled,
             COUNT(CASE WHEN status = 'liquidated' THEN 1 END) as liquidated,
             MIN(created_at) as primera,
             MAX(created_at) as ultima
      FROM repartidor_assignments
      WHERE branch_id = $1
    `, [BID]);
    console.log('=== ASIGNACIONES EN POSTGRESQL (branch 47) ===');
    console.log(JSON.stringify(totalAssignments.rows[0], null, 2));

    // 2. Turnos activos vs cerrados
    const shifts = await pool.query(`
      SELECT id, global_id, employee_id, is_cash_cut_open,
             created_at,
             (SELECT CONCAT(first_name, ' ', last_name) FROM employees WHERE id = s.employee_id) as employee_name
      FROM shifts s
      WHERE branch_id = $1
      ORDER BY created_at DESC
      LIMIT 15
    `, [BID]);
    console.log('\n=== ULTIMOS 15 TURNOS (branch 47) ===');
    shifts.rows.forEach(r => {
      const status = r.is_cash_cut_open ? '🟢 ABIERTO' : '🔴 CERRADO';
      console.log(`  Shift ${r.id} (${r.global_id?.substring(0,8)}...) | ${status} | ${r.employee_name} | created: ${r.created_at}`);
    });

    // 3. Asignaciones recientes - ver si hay asignaciones cuyo turno ya está cerrado
    const assignmentsWithShifts = await pool.query(`
      SELECT ra.id, ra.global_id, ra.status, ra.assigned_quantity, ra.assigned_amount,
             ra.created_at as assignment_date,
             ra.shift_id, s.is_cash_cut_open as shift_open,
             ra.repartidor_shift_id, rs.is_cash_cut_open as rep_shift_open,
             (SELECT CONCAT(first_name, ' ', last_name) FROM employees WHERE id = ra.employee_id) as repartidor,
             ra.source, ra.terminal_id
      FROM repartidor_assignments ra
      LEFT JOIN shifts s ON ra.shift_id = s.id
      LEFT JOIN shifts rs ON ra.repartidor_shift_id = rs.id
      WHERE ra.branch_id = $1
      ORDER BY ra.created_at DESC
      LIMIT 30
    `, [BID]);
    console.log('\n=== ULTIMAS 30 ASIGNACIONES ===');
    assignmentsWithShifts.rows.forEach(r => {
      const shiftStatus = r.shift_id ? (r.shift_open ? '🟢turno-abierto' : '🔴turno-cerrado') : '⚪sin-turno';
      console.log(`  Asig ${r.id} (${r.global_id?.substring(0,8)}...) | ${r.status.padEnd(10)} | $${r.assigned_amount} | ${r.repartidor} | ${shiftStatus} | ${r.source || 'desktop'} | ${r.assignment_date}`);
    });

    // 4. Devoluciones pendientes
    const returns = await pool.query(`
      SELECT COUNT(*) as total,
             COUNT(CASE WHEN status = 'confirmed' THEN 1 END) as confirmed,
             COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending
      FROM repartidor_returns
      WHERE branch_id = $1
    `, [BID]);
    console.log('\n=== DEVOLUCIONES EN POSTGRESQL ===');
    console.log(JSON.stringify(returns.rows[0], null, 2));

    // 5. Liquidaciones
    const liquidations = await pool.query(`
      SELECT COUNT(*) as total
      FROM repartidor_liquidations
      WHERE branch_id = $1
    `, [BID]);
    console.log('\n=== LIQUIDACIONES EN POSTGRESQL ===');
    console.log(JSON.stringify(liquidations.rows[0], null, 2));

    // 6. CLAVE: Verificar si hay asignaciones duplicadas por global_id
    // Esto indicaría que el respaldo restauró registros que YA estaban en PG
    const dupes = await pool.query(`
      SELECT global_id, COUNT(*) as veces
      FROM repartidor_assignments
      WHERE branch_id = $1
      GROUP BY global_id
      HAVING COUNT(*) > 1
    `, [BID]);
    console.log('\n=== GLOBAL_IDs DUPLICADOS (indica re-sync de respaldo) ===');
    if (dupes.rows.length === 0) {
      console.log('  Ningún duplicado (sync usa ON CONFLICT correctamente)');
    } else {
      dupes.rows.forEach(r => console.log(`  ${r.global_id}: ${r.veces} veces`));
    }

    // 7. Verificar el endpoint de sync - ¿usa ON CONFLICT?
    console.log('\n=== DIAGNÓSTICO DE HIPÓTESIS "RESPALDO" ===');

    // Contar cuántas asignaciones en PG tienen turnos cerrados
    const closedShiftAssignments = await pool.query(`
      SELECT ra.status, COUNT(*) as total
      FROM repartidor_assignments ra
      JOIN shifts s ON ra.shift_id = s.id
      WHERE ra.branch_id = $1
        AND s.is_cash_cut_open = false
      GROUP BY ra.status
    `, [BID]);
    console.log('Asignaciones en turnos YA CERRADOS:');
    closedShiftAssignments.rows.forEach(r => console.log(`  ${r.status}: ${r.total}`));

    // Asignaciones en turnos ABIERTOS
    const openShiftAssignments = await pool.query(`
      SELECT ra.status, COUNT(*) as total
      FROM repartidor_assignments ra
      JOIN shifts s ON ra.shift_id = s.id
      WHERE ra.branch_id = $1
        AND s.is_cash_cut_open = true
      GROUP BY ra.status
    `, [BID]);
    console.log('Asignaciones en turnos ABIERTOS:');
    openShiftAssignments.rows.forEach(r => console.log(`  ${r.status}: ${r.total}`));

    // 8. Verificar ventas no sincronizadas que podrían bloquear asignaciones
    // En PG todas están "sincronizadas" por definición, pero Desktop puede tener
    // ventas locales con Synced=false que bloquean el handler
    const ventasByTerminal = await pool.query(`
      SELECT terminal_id, COUNT(*) as total
      FROM ventas
      WHERE branch_id = $1
      GROUP BY terminal_id
      ORDER BY total DESC
    `, [BID]);
    console.log('\n=== VENTAS POR TERMINAL_ID (origen) ===');
    ventasByTerminal.rows.forEach(r => console.log(`  ${r.terminal_id}: ${r.total} ventas`));

    await pool.end();
  } catch(e) {
    console.error('Error:', e.message);
    await pool.end();
  }
})();
