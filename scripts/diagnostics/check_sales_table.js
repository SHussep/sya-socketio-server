#!/usr/bin/env node

/**
 * Script para verificar el estado actual de la tabla sales en producción
 * Uso: node check_sales_table.js
 */

const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

async function checkSalesTable() {
  const client = await pool.connect();

  try {
    console.log('🔍 Verificando tabla sales...\n');

    // 1. Verificar estructura de columnas
    console.log('═══════════════════════════════════════════════════════════');
    console.log('1️⃣  ESTRUCTURA DE COLUMNAS:');
    console.log('═══════════════════════════════════════════════════════════\n');

    const schemaQuery = `
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = 'sales'
      ORDER BY ordinal_position;
    `;

    const schemaResult = await client.query(schemaQuery);
    schemaResult.rows.forEach(col => {
      const nullable = col.is_nullable === 'NO' ? '✅ NOT NULL' : '⚠️  NULLABLE';
      const hasDefault = col.column_default ? `Default: ${col.column_default}` : '(sin default)';
      console.log(`  ${col.column_name.padEnd(20)} | ${col.data_type.padEnd(25)} | ${nullable} | ${hasDefault}`);
    });

    // 2. Contar ventas totales
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('2️⃣  ESTADÍSTICAS DE VENTAS:');
    console.log('═══════════════════════════════════════════════════════════\n');

    const statsQuery = `
      SELECT
        COUNT(*) as total_ventas,
        COUNT(CASE WHEN sale_date IS NULL THEN 1 END) as ventas_sin_fecha,
        COUNT(CASE WHEN employee_id IS NULL THEN 1 END) as ventas_sin_empleado,
        MIN(sale_date) as fecha_mas_antigua,
        MAX(sale_date) as fecha_mas_reciente
      FROM sales;
    `;

    const statsResult = await client.query(statsQuery);
    const stats = statsResult.rows[0];

    console.log(`  Total de ventas: ${stats.total_ventas}`);
    console.log(`  Ventas sin fecha: ${stats.ventas_sin_fecha}`);
    console.log(`  Ventas sin empleado: ${stats.ventas_sin_empleado}`);
    console.log(`  Fecha más antigua: ${stats.fecha_mas_antigua}`);
    console.log(`  Fecha más reciente: ${stats.fecha_mas_reciente}`);

    // 3. Mostrar últimas 10 ventas
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('3️⃣  ÚLTIMAS 10 VENTAS:');
    console.log('═══════════════════════════════════════════════════════════\n');

    const recentQuery = `
      SELECT
        id,
        ticket_number,
        total_amount,
        payment_method,
        sale_type,
        sale_date,
        employee_id,
        branch_id
      FROM sales
      ORDER BY sale_date DESC
      LIMIT 10;
    `;

    const recentResult = await client.query(recentQuery);

    if (recentResult.rows.length === 0) {
      console.log('  ⚠️  No hay ventas en la base de datos');
    } else {
      recentResult.rows.forEach((sale, idx) => {
        console.log(`  ${idx + 1}. Ticket #${sale.ticket_number} | $${sale.total_amount} | ${sale.payment_method} | ${sale.sale_date}`);
        console.log(`     ID: ${sale.id} | Employee: ${sale.employee_id} | Branch: ${sale.branch_id}`);
      });
    }

    // 4. Verificar errores recientes
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('4️⃣  INFORMACIÓN ADICIONAL:');
    console.log('═══════════════════════════════════════════════════════════\n');

    console.log('  ✅ Conexión a PostgreSQL exitosa');
    console.log('  ✅ Tabla "sales" existe y es accesible');

    if (stats.ventas_sin_fecha > 0) {
      console.log(`  ⚠️  ADVERTENCIA: Hay ${stats.ventas_sin_fecha} ventas con sale_date = NULL`);
      console.log('     Esto significa que la migración 003 NO se ejecutó correctamente.');
      console.log('     Necesitas ejecutar: node run_migration_003.js');
    } else {
      console.log('  ✅ Todas las ventas tienen fecha (migración 003 aplicada correctamente)');
    }

  } catch (error) {
    console.error('❌ ERROR:', error.message);
    console.error(error);
  } finally {
    client.release();
    await pool.end();
  }
}

checkSalesTable();
