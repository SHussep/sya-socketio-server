// Script para verificar unidades en la base de datos de Render
// Uso: DATABASE_URL=postgresql://... node check_units_remote.js

const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('Error: DATABASE_URL no está definida');
  console.log('Uso: DATABASE_URL=postgresql://... node check_units_remote.js');
  process.exit(1);
}

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false }
});

async function check() {
  try {
    console.log('='.repeat(60));
    console.log('ANÁLISIS DE UNIDADES EN REPARTIDOR_ASSIGNMENTS');
    console.log('='.repeat(60));

    // 1. Ver distribución de unidades en asignaciones
    const units = await pool.query(`
      SELECT
        COALESCE(unit_abbreviation, 'NULL') as unit,
        COUNT(*) as count
      FROM repartidor_assignments
      GROUP BY unit_abbreviation
      ORDER BY count DESC
    `);
    console.log('\n📊 Distribución de unidades en repartidor_assignments:');
    units.rows.forEach(r => {
      console.log(`   ${r.unit}: ${r.count} registros`);
    });

    // 2. Ver productos que NO son kg
    const nonKgProducts = await pool.query(`
      SELECT
        p.descripcion,
        p.unidad_venta,
        p.unidad_medida_id
      FROM productos p
      WHERE p.unidad_venta IS NOT NULL AND p.unidad_venta != 'kg'
      LIMIT 20
    `);
    console.log('\n📦 Productos con unidad diferente a "kg":');
    if (nonKgProducts.rows.length === 0) {
      console.log('   ⚠️ Ninguno encontrado - puede ser que unidad_venta no esté poblado');
    } else {
      nonKgProducts.rows.forEach(r => {
        console.log(`   - ${r.descripcion}: ${r.unidad_venta} (unidad_medida_id: ${r.unidad_medida_id})`);
      });
    }

    // 3. Ver últimas 10 asignaciones con su unidad
    const recent = await pool.query(`
      SELECT
        ra.id,
        ra.product_name,
        ra.unit_abbreviation,
        ra.assigned_quantity,
        ra.fecha_asignacion
      FROM repartidor_assignments ra
      ORDER BY ra.id DESC
      LIMIT 10
    `);
    console.log('\n🕒 Últimas 10 asignaciones:');
    recent.rows.forEach(r => {
      const fecha = new Date(r.fecha_asignacion).toLocaleDateString();
      console.log(`   #${r.id} - ${r.product_name}: ${r.assigned_quantity} ${r.unit_abbreviation || 'kg'} (${fecha})`);
    });

    // 4. Ver si hay asignaciones recientes con unidad diferente a kg
    const recentNonKg = await pool.query(`
      SELECT
        ra.id,
        ra.product_name,
        ra.unit_abbreviation,
        ra.assigned_quantity,
        ra.fecha_asignacion
      FROM repartidor_assignments ra
      WHERE ra.unit_abbreviation IS NOT NULL
        AND ra.unit_abbreviation != 'kg'
      ORDER BY ra.id DESC
      LIMIT 10
    `);
    console.log('\n🔍 Asignaciones con unidad != "kg":');
    if (recentNonKg.rows.length === 0) {
      console.log('   ⚠️ NINGUNA - Todas las asignaciones tienen "kg" o NULL');
    } else {
      recentNonKg.rows.forEach(r => {
        console.log(`   #${r.id} - ${r.product_name}: ${r.assigned_quantity} ${r.unit_abbreviation}`);
      });
    }

    console.log('\n' + '='.repeat(60));

  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await pool.end();
  }
}

check();
