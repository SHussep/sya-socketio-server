const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  host: 'dpg-d3i8dv3e5dus738tm5rg-a.oregon-postgres.render.com',
  user: 'sya_admin',
  password: 'qJ1haIaPp7m7OFMyicWSplPlGoNL1GpF',
  database: 'sya_db_oe4v',
  port: 5432,
  ssl: { rejectUnauthorized: false }
});

async function applyMigration() {
  try {
    console.log('🚀 Aplicando migración 004: Mejorar tabla SALES...\n');

    // Leer archivo SQL
    const migrationPath = path.join(__dirname, 'migrations', '004_enhance_sales_table.sql');
    const migrationSQL = fs.readFileSync(migrationPath, 'utf8');

    // Ejecutar migración
    await pool.query(migrationSQL);

    console.log('✅ Migración aplicada exitosamente!\n');

    // Verificar nuevas columnas
    console.log('═══════════════════════════════════════════════════════');
    console.log('NUEVAS COLUMNAS AGREGADAS:');
    console.log('═══════════════════════════════════════════════════════\n');

    const { rows: columns } = await pool.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'sales'
      AND column_name IN (
        'shift_id', 'branch_sale_number', 'shift_sale_number',
        'payment_type', 'is_credit_sale', 'card_type',
        'subtotal', 'discount_amount', 'tax_amount',
        'cash_received', 'change_given', 'sale_status',
        'is_cancelled', 'is_delivery', 'delivery_fee',
        'synced_to_cloud', 'receipt_printed'
      )
      ORDER BY column_name;
    `);

    columns.forEach(col => {
      console.log(`  ✅ ${col.column_name.padEnd(30)} ${col.data_type.padEnd(20)} ${col.is_nullable === 'YES' ? 'NULL' : 'NOT NULL'}`);
    });

    // Verificar índices
    console.log('\n═══════════════════════════════════════════════════════');
    console.log('ÍNDICES CREADOS:');
    console.log('═══════════════════════════════════════════════════════\n');

    const { rows: indexes } = await pool.query(`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE tablename = 'sales'
      AND indexname LIKE 'idx_sales%';
    `);

    indexes.forEach(idx => {
      console.log(`  ✅ ${idx.indexname}`);
    });

    // Verificar vista
    console.log('\n═══════════════════════════════════════════════════════');
    console.log('VISTAS CREADAS:');
    console.log('═══════════════════════════════════════════════════════\n');

    const { rows: views } = await pool.query(`
      SELECT viewname
      FROM pg_views
      WHERE viewname = 'v_sales_complete';
    `);

    if (views.length > 0) {
      console.log('  ✅ v_sales_complete');
      console.log('     Esta vista incluye información completa de ventas para la app móvil');
    }

    console.log('\n═══════════════════════════════════════════════════════');
    console.log('RESUMEN DE MEJORAS:');
    console.log('═══════════════════════════════════════════════════════\n');

    console.log('  ✅ Identificación única de ventas con shift_id');
    console.log('  ✅ Desglose completo de métodos de pago');
    console.log('  ✅ Soporte para ventas a crédito');
    console.log('  ✅ Soporte para pagos con tarjeta');
    console.log('  ✅ Desglose de montos (subtotal, descuento, IVA)');
    console.log('  ✅ Estados de venta (completada, cancelada, etc.)');
    console.log('  ✅ Soporte para delivery');
    console.log('  ✅ Auditoría mejorada');
    console.log('  ✅ Índices para consultas rápidas');
    console.log('  ✅ Vista completa para app móvil\n');

    pool.end();
  } catch (error) {
    console.error('❌ Error aplicando migración:', error.message);
    console.error(error.stack);
    pool.end();
    process.exit(1);
  }
}

applyMigration();
