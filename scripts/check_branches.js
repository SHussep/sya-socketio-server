const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

(async () => {
  try {
    const res = await pool.query(`
      SELECT
        e.id as emp_id,
        e.global_id,
        e.first_name || ' ' || e.last_name as name,
        e.email,
        e.main_branch_id,
        e.is_active as emp_active,
        e.can_use_mobile_app,
        r.name as role_name,
        eb.branch_id,
        b.name as branch_name,
        eb.removed_at IS NULL as branch_active
      FROM employees e
      LEFT JOIN roles r ON r.id = e.role_id
      LEFT JOIN employee_branches eb ON eb.employee_id = e.id
      LEFT JOIN branches b ON b.id = eb.branch_id
      WHERE e.tenant_id = 34
      ORDER BY e.id, eb.branch_id
    `);

    console.table(res.rows);
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await pool.end();
  }
})();
