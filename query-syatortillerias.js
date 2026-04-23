require('dotenv').config();
const { Pool } = require('pg');

const pg = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

(async () => {
  try {
    const TENANT_ID = 90;

    const openShifts = await pg.query(
      `SELECT s.id, s.employee_id, s.branch_id, b.name AS branch_name,
              CASE WHEN s.end_time IS NULL THEN 'open' ELSE 'closed' END AS status, s.start_time, s.end_time,
              TRIM(CONCAT(COALESCE(e.first_name,''), ' ', COALESCE(e.last_name,''))) AS emp_name,
              e.email
       FROM shifts s
       JOIN employees e ON e.id = s.employee_id
       JOIN branches b ON b.id = s.branch_id
       WHERE e.tenant_id = $1 AND s.end_time IS NULL
       ORDER BY s.start_time DESC`,
      [TENANT_ID]
    );
    console.log(`\nTurnos ABIERTOS en tenant ${TENANT_ID}: ${openShifts.rowCount}`);
    console.table(openShifts.rows);

    // Últimos 10 turnos (abiertos o cerrados) para contexto
    const recentShifts = await pg.query(
      `SELECT s.id, s.employee_id, s.branch_id, b.name AS branch_name,
              CASE WHEN s.end_time IS NULL THEN 'open' ELSE 'closed' END AS status, s.start_time, s.end_time,
              TRIM(CONCAT(COALESCE(e.first_name,''), ' ', COALESCE(e.last_name,''))) AS emp_name
       FROM shifts s
       JOIN employees e ON e.id = s.employee_id
       JOIN branches b ON b.id = s.branch_id
       WHERE e.tenant_id = $1
       ORDER BY s.start_time DESC
       LIMIT 10`,
      [TENANT_ID]
    );
    console.log(`\nÚltimos 10 turnos del tenant ${TENANT_ID}:`);
    console.table(recentShifts.rows);

    // Employee_branches — ver a qué sucursales está vinculado el owner
    const empBranches = await pg.query(
      `SELECT eb.employee_id, eb.branch_id, b.name AS branch_name,
              TRIM(CONCAT(COALESCE(e.first_name,''), ' ', COALESCE(e.last_name,''))) AS emp_name,
              e.email, eb.assigned_at, eb.removed_at
       FROM employee_branches eb
       JOIN employees e ON e.id = eb.employee_id
       JOIN branches b ON b.id = eb.branch_id
       WHERE e.tenant_id = $1 AND e.email = 'syatortillerias@gmail.com'
       ORDER BY eb.branch_id`,
      [TENANT_ID]
    );
    console.log(`\nEmployee_branches del dueño (syatortillerias@gmail.com):`);
    console.table(empBranches.rows);

    await pg.end();
  } catch (e) {
    console.error('ERROR:', e.message);
    await pg.end();
    process.exit(1);
  }
})();
