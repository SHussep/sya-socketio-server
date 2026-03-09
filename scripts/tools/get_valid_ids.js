#!/usr/bin/env node

/**
 * Script para obtener IDs válidos de ventas, empleados y sucursales
 * para hacer pruebas realistas
 */

const { pool } = require('./database');
require('dotenv').config();

async function getValidIds() {
  console.log('📋 Obteniendo IDs válidos del sistema...\n');

  try {
    const client = await pool.connect();

    // 1. Obtener últimas ventas
    console.log('1️⃣  ÚLTIMAS VENTAS:');
    console.log('─'.repeat(50));
    const salesQuery = `
      SELECT id, employee_id, branch_id, tenant_id
      FROM sales
      WHERE employee_id IS NOT NULL
      ORDER BY id DESC
      LIMIT 5;
    `;

    const salesResult = await client.query(salesQuery);
    let saleId, employeeId, branchId, tenantId;

    if (salesResult.rows.length > 0) {
      salesResult.rows.forEach((row, idx) => {
        console.log(`\n  Venta ${idx + 1}:`);
        console.log(`    ID: ${row.id}`);
        console.log(`    Employee: ${row.employee_id}`);
        console.log(`    Branch: ${row.branch_id}`);
        console.log(`    Tenant: ${row.tenant_id}`);
      });

      const firstSale = salesResult.rows[0];
      saleId = firstSale.id;
      employeeId = firstSale.employee_id;
      branchId = firstSale.branch_id;
      tenantId = firstSale.tenant_id;

      console.log('\n✅ Usando primera venta para pruebas\n');
    } else {
      console.log('❌ No hay ventas con employee_id');
      client.release();
      process.exit(1);
    }

    // 2. Verificar empleado
    console.log('2️⃣  EMPLEADO:');
    console.log('─'.repeat(50));

    const employeeQuery = `
      SELECT id, nombre, apellidos, role
      FROM employees
      WHERE id = $1;
    `;

    const employeeResult = await client.query(employeeQuery, [employeeId]);

    if (employeeResult.rows.length > 0) {
      const emp = employeeResult.rows[0];
      console.log(`  ID: ${emp.id}`);
      console.log(`  Nombre: ${emp.nombre} ${emp.apellidos}`);
      console.log(`  Role: ${emp.role}\n`);
    }

    // 3. Verificar sucursal
    console.log('3️⃣  SUCURSAL:');
    console.log('─'.repeat(50));

    const branchQuery = `
      SELECT id, branch_name, ciudad
      FROM branches
      WHERE id = $1;
    `;

    const branchResult = await client.query(branchQuery, [branchId]);

    if (branchResult.rows.length > 0) {
      const branch = branchResult.rows[0];
      console.log(`  ID: ${branch.id}`);
      console.log(`  Nombre: ${branch.branch_name}`);
      console.log(`  Ciudad: ${branch.ciudad}\n`);
    }

    // 4. Verificar tenant
    console.log('4️⃣  TENANT:');
    console.log('─'.repeat(50));

    const tenantQuery = `
      SELECT id, nombre
      FROM tenants
      WHERE id = $1;
    `;

    const tenantResult = await client.query(tenantQuery, [tenantId]);

    if (tenantResult.rows.length > 0) {
      const tenant = tenantResult.rows[0];
      console.log(`  ID: ${tenant.id}`);
      console.log(`  Nombre: ${tenant.nombre}\n`);
    }

    // Salida con los IDs para usar en las pruebas
    console.log('╔════════════════════════════════════════════════════════╗');
    console.log('║          PARÁMETROS PARA PRUEBAS                      ║');
    console.log('╚════════════════════════════════════════════════════════╝\n');

    console.log('Usa estos valores para las pruebas:');
    console.log(`  sale_id: ${saleId}`);
    console.log(`  employee_id: ${employeeId}`);
    console.log(`  branch_id: ${branchId}`);
    console.log(`  tenant_id: ${tenantId}\n`);

    console.log('Ejemplo de payload:');
    console.log(JSON.stringify({
      sale_id: saleId,
      employee_id: employeeId,
      branch_id: branchId,
      tenant_id: tenantId,
      cantidad_asignada: 50.0,
      monto_asignado: 2500.00,
      observaciones: 'Prueba de sistema de repartidores',
    }, null, 2));

    client.release();
    process.exit(0);

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

getValidIds().catch(error => {
  console.error('❌ Error fatal:', error);
  process.exit(1);
});
