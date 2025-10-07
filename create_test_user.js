const bcrypt = require('bcrypt');
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function createTestUser() {
  const client = await pool.connect();

  try {
    console.log('🔐 Creando usuario de prueba...');

    // Hashear password
    const hashedPassword = await bcrypt.hash('1234', 10);

    // 1. Crear Tenant
    const tenantResult = await client.query(`
      INSERT INTO tenants (tenant_code, business_name, email, subscription_status, created_at)
      VALUES ('SYA001', 'SYA Tortillerías', 'saul.hussep@gmail.com', 'trial', NOW())
      ON CONFLICT (tenant_code) DO UPDATE SET business_name = EXCLUDED.business_name
      RETURNING id, tenant_code
    `);

    const tenantId = tenantResult.rows[0].id;
    const tenantCode = tenantResult.rows[0].tenant_code;
    console.log(`✅ Tenant creado: ${tenantCode} (ID: ${tenantId})`);

    // 2. Crear Branch
    const branchResult = await client.query(`
      INSERT INTO branches (tenant_id, branch_code, name, is_main, created_at)
      VALUES ($1, 'MAIN', 'Sucursal Principal', true, NOW())
      ON CONFLICT (tenant_id, branch_code) DO UPDATE SET name = EXCLUDED.name
      RETURNING id
    `, [tenantId]);

    const branchId = branchResult.rows[0].id;
    console.log(`✅ Sucursal creada (ID: ${branchId})`);

    // 3. Crear Employee (Usuario)
    const employeeResult = await client.query(`
      INSERT INTO employees (
        tenant_id,
        branch_id,
        email,
        username,
        full_name,
        password_hash,
        role,
        is_owner,
        is_active,
        created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
      ON CONFLICT (tenant_id, email) DO UPDATE
      SET password_hash = EXCLUDED.password_hash,
          username = EXCLUDED.username
      RETURNING id, email, username
    `, [
      tenantId,
      branchId,
      'saul.hussep@gmail.com',
      'saulhussep',
      'Saul Hussep',
      hashedPassword,
      'Administrador',
      true,
      true
    ]);

    const employee = employeeResult.rows[0];
    console.log(`✅ Usuario creado: ${employee.username} (${employee.email})`);
    console.log('');
    console.log('═══════════════════════════════════════════');
    console.log('  CREDENCIALES PARA LOGIN MÓVIL:');
    console.log('═══════════════════════════════════════════');
    console.log(`  Usuario: ${employee.username}`);
    console.log(`  Email: ${employee.email}`);
    console.log(`  Password: 1234`);
    console.log('═══════════════════════════════════════════');

  } catch (error) {
    console.error('❌ Error:', error.message);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

createTestUser()
  .then(() => {
    console.log('\n✅ Usuario de prueba creado exitosamente');
    process.exit(0);
  })
  .catch(err => {
    console.error('\n❌ Error al crear usuario:', err);
    process.exit(1);
  });
