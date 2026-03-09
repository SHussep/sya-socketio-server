const { Pool } = require('pg');

// ⚠️ SEGURIDAD: DATABASE_URL debe estar configurado en el entorno
if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL no está configurado. Ejecuta: export DATABASE_URL=postgresql://...');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function check() {
  const result = await pool.query(`
    SELECT DISTINCT unit_abbreviation, COUNT(*) as count
    FROM repartidor_assignments
    WHERE tenant_id = 1
    GROUP BY unit_abbreviation
    ORDER BY count DESC
  `);
  console.log('Unidades en repartidor_assignments:');
  console.log(result.rows);

  const products = await pool.query(`
    SELECT DISTINCT unidad_venta, COUNT(*) as count
    FROM productos
    WHERE tenant_id = 1
    GROUP BY unidad_venta
    ORDER BY count DESC
    LIMIT 10
  `);
  console.log('\nUnidades en productos:');
  console.log(products.rows);

  // Ver algunas asignaciones con su producto
  const samples = await pool.query(`
    SELECT ra.id, ra.unit_abbreviation as ra_unit, ra.product_name, p.unidad_venta as product_unit
    FROM repartidor_assignments ra
    LEFT JOIN productos p ON ra.product_id = p.id_producto
    WHERE ra.tenant_id = 1
    ORDER BY ra.id DESC
    LIMIT 10
  `);
  console.log('\nMuestras de asignaciones:');
  console.log(samples.rows);

  await pool.end();
}
check();
