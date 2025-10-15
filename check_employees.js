const { Pool } = require('pg');

const pool = new Pool({
  host: 'dpg-d3i8dv3e5dus738tm5rg-a.oregon-postgres.render.com',
  port: 5432,
  user: 'sya_admin',
  password: 'qJ1haIaPp7m7OFMyicWSplPlGoNL1GpF',
  database: 'sya_db_oe4v',
  ssl: { rejectUnauthorized: false }
});

async function checkEmployees() {
  try {
    console.log('👥 Verificando empleados para tenant_id=24...\n');

    // Check employees for tenant 24
    const employees = await pool.query(
      `SELECT id, tenant_id, username, full_name, email, role, main_branch_id
       FROM employees
       WHERE tenant_id = 24
       ORDER BY id ASC`
    );

    console.log(`✅ Empleados encontrados: ${employees.rows.length}\n`);

    employees.rows.forEach(emp => {
      console.log(`  ID: ${emp.id}`);
      console.log(`  Username: ${emp.username}`);
      console.log(`  Nombre: ${emp.full_name}`);
      console.log(`  Email: ${emp.email}`);
      console.log(`  Role: ${emp.role}`);
      console.log(`  Branch: ${emp.main_branch_id}`);
      console.log('  ---');
    });

    // Check branches for tenant 24
    const branches = await pool.query(
      `SELECT id, tenant_id, branch_code, name
       FROM branches
       WHERE tenant_id = 24
       ORDER BY id ASC`
    );

    console.log(`\n🏢 Sucursales encontradas: ${branches.rows.length}\n`);

    branches.rows.forEach(branch => {
      console.log(`  ID: ${branch.id}`);
      console.log(`  Code: ${branch.branch_code}`);
      console.log(`  Name: ${branch.name}`);
      console.log('  ---');
    });

    await pool.end();
  } catch (error) {
    console.error('❌ Error:', error.message);
    await pool.end();
  }
}

checkEmployees();
