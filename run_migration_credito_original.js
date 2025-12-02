/**
 * Migración: Agregar columna credito_original a tabla ventas
 *
 * Esta columna almacena el monto de crédito generado AL MOMENTO DE LA VENTA.
 * Este valor NUNCA cambia después de crear la venta, lo que permite auditoría
 * perfecta del historial de créditos incluso después de que se registren abonos.
 *
 * PROBLEMA QUE RESUELVE:
 * El campo monto_pagado se actualiza cuando se registran abonos (pagos), lo que
 * corrompe el cálculo del historial de estado de cuenta. Con credito_original
 * podemos saber exactamente cuánto crédito se generó en cada venta.
 *
 * LÓGICA DE CÁLCULO:
 * - tipo_pago_id = 1 (Efectivo): credito_original = 0
 * - tipo_pago_id = 2 (Tarjeta): credito_original = 0
 * - tipo_pago_id = 3 (Crédito puro): credito_original = total
 * - tipo_pago_id = 4 (Mixto): credito_original = total - anticipo
 *
 * Ejecutar: node run_migration_credito_original.js
 */

const { pool } = require('./database');

async function runMigration() {
  console.log('🚀 Iniciando migración: credito_original en ventas');

  try {
    // 1. Verificar si la columna ya existe
    const checkColumn = await pool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'ventas' AND column_name = 'credito_original'
    `);

    if (checkColumn.rows.length > 0) {
      console.log('✅ La columna credito_original ya existe en la tabla ventas');
    } else {
      // 2. Agregar la columna
      console.log('📝 Agregando columna credito_original a tabla ventas...');
      await pool.query(`
        ALTER TABLE ventas
        ADD COLUMN credito_original DECIMAL(12, 2) NOT NULL DEFAULT 0
      `);
      console.log('✅ Columna credito_original agregada');
    }

    // 3. Recalcular credito_original para ventas existentes
    console.log('📊 Recalculando credito_original para ventas existentes...');

    // 3a. Para ventas de CONTADO (tipo_pago_id = 1 o 2): credito_original = 0
    const updateContado = await pool.query(`
      UPDATE ventas
      SET credito_original = 0
      WHERE tipo_pago_id IN (1, 2)
    `);
    console.log(`  - Contado (tipo 1,2): ${updateContado.rowCount} ventas actualizadas`);

    // 3b. Para ventas de CRÉDITO PURO (tipo_pago_id = 3): credito_original = total
    const updateCredito = await pool.query(`
      UPDATE ventas
      SET credito_original = total
      WHERE tipo_pago_id = 3
    `);
    console.log(`  - Crédito puro (tipo 3): ${updateCredito.rowCount} ventas actualizadas`);

    // 3c. Para ventas MIXTAS (tipo_pago_id = 4): Reconstruir el crédito original
    // Nota: Para PostgreSQL, usamos una aproximación ya que no tenemos PagoAplicaciones
    // El crédito original = total - anticipo original
    // Si monto_pagado <= total, asumimos que el anticipo original fue monto_pagado
    // (esto puede no ser 100% preciso para ventas antiguas con abonos)
    const updateMixto = await pool.query(`
      UPDATE ventas
      SET credito_original = GREATEST(0, total - monto_pagado)
      WHERE tipo_pago_id = 4
    `);
    console.log(`  - Mixtas (tipo 4): ${updateMixto.rowCount} ventas actualizadas`);

    // 3d. Para ventas sin tipo_pago_id o valores desconocidos: credito_original = 0
    const updateNull = await pool.query(`
      UPDATE ventas
      SET credito_original = 0
      WHERE tipo_pago_id IS NULL OR tipo_pago_id NOT IN (1, 2, 3, 4)
    `);
    console.log(`  - Sin tipo/desconocido: ${updateNull.rowCount} ventas actualizadas`);

    // 4. Crear índice para consultas de auditoría
    console.log('📝 Creando índice para credito_original...');
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_ventas_credito_original
      ON ventas(credito_original)
      WHERE credito_original > 0
    `);
    console.log('✅ Índice creado');

    // 5. Mostrar estadísticas
    const stats = await pool.query(`
      SELECT
        tipo_pago_id,
        COUNT(*) as total_ventas,
        SUM(credito_original) as total_credito,
        AVG(credito_original) as promedio_credito
      FROM ventas
      GROUP BY tipo_pago_id
      ORDER BY tipo_pago_id
    `);

    console.log('\n📊 Estadísticas de credito_original:');
    console.log('────────────────────────────────────────');
    stats.rows.forEach(row => {
      const tipoPago = {
        1: 'Efectivo',
        2: 'Tarjeta',
        3: 'Crédito',
        4: 'Mixto'
      }[row.tipo_pago_id] || `Tipo ${row.tipo_pago_id}`;

      console.log(`  ${tipoPago}:`);
      console.log(`    - Ventas: ${row.total_ventas}`);
      console.log(`    - Crédito total: $${parseFloat(row.total_credito || 0).toFixed(2)}`);
      console.log(`    - Promedio: $${parseFloat(row.promedio_credito || 0).toFixed(2)}`);
    });

    console.log('\n✅ Migración completada exitosamente');

  } catch (error) {
    console.error('❌ Error en migración:', error.message);
    throw error;
  } finally {
    await pool.end();
  }
}

runMigration();
