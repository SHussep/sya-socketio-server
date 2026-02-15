require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function cleanDatabase() {
  try {
    console.log('🔍 Iniciando limpieza de base de datos...\n');
    console.log('📌 NOTA: La tabla "subscriptions" será preservada (master data)\n');

    // Desabilitar constraints temporalmente
    await pool.query('SET CONSTRAINTS ALL DEFERRED');

    // Lista de tablas a limpiar (en orden inverso de dependencias)
    // NOTA: global_expense_categories NO se limpia (es master data)
    const tablesToClean = [
      'guardian_events',
      'cash_cuts',
      'repartidor_assignments',
      'shifts',
      'purchase_items',
      'purchases',
      'sale_items',
      'sales',
      'expenses',
      'suppliers',
      'customers',
      'branch_inventory',
      'products',
      'employee_branches',
      'employees',
      'branches',
      'tenants'
    ];

    // Limpiar cada tabla
    for (const table of tablesToClean) {
      try {
        const result = await pool.query(`DELETE FROM "${table}"`);
        console.log(`✅ ${table.padEnd(30)} - ${result.rowCount} registros eliminados`);
      } catch (error) {
        console.log(`⏭️  ${table.padEnd(30)} - Omitida (no existe o error: ${error.message.split('\n')[0]})`);
      }
    }

    console.log('\n🔍 Verificando subscriptions...\n');

    // Verificar que subscriptions tiene data
    const subsResult = await pool.query('SELECT id, name, max_branches FROM subscriptions ORDER BY id');
    if (subsResult.rows.length === 0) {
      console.log('⚠️  No hay subscriptions en la base de datos');
      console.log('   Insertando subscriptions predeterminadas...\n');

      await pool.query(`
        INSERT INTO subscriptions (name, max_branches, max_devices, max_employees, price_monthly, features) VALUES
        ('Free', 1, 3, 5, 0.00, '{"sync_interval": 3600, "support": "email", "storage_gb": 1}'),
        ('Basic', 3, 10, 15, 299.00, '{"sync_interval": 300, "support": "priority", "reports": "basic", "storage_gb": 10}'),
        ('Pro', 10, 30, 50, 799.00, '{"sync_interval": 60, "support": "24/7", "reports": "advanced", "api": true, "storage_gb": 100}'),
        ('Enterprise', -1, -1, -1, 1999.00, '{"sync_interval": 10, "support": "dedicated", "reports": "custom", "api": true, "white_label": true, "storage_gb": 500}')
      `);

      console.log('✅ Subscriptions predeterminadas insertadas\n');
    } else {
      console.log('📋 Subscriptions preservadas:\n');
      subsResult.rows.forEach(row => {
        console.log(`   ID ${row.id}: ${row.name.padEnd(15)} (max ${row.max_branches} sucursales)`);
      });
      console.log();
    }

    // Reabilitar constraints
    await pool.query('SET CONSTRAINTS ALL IMMEDIATE');

    console.log('✅ Limpieza completada exitosamente\n');
    console.log('📊 Estado final de la base de datos:');
    console.log('   - Tenants: 0');
    console.log('   - Branches: 0');
    console.log('   - Employees: 0');
    console.log('   - Products: 0');
    console.log('   - Sales: 0');
    console.log('   - Expenses: 0');
    console.log('   - Cash Cuts: 0');
    console.log('   - Guardian Events: 0');
    console.log('   - Subscriptions: PRESERVADAS (master data)\n');
    console.log('✨ La base de datos está lista para comenzar con nuevos usuarios y correctos IDs\n');

    pool.end();
  } catch (error) {
    console.error('❌ Error durante la limpieza:', error.message);
    pool.end();
    process.exit(1);
  }
}

cleanDatabase();
