/**
 * Migracion: Agregar columna RFC a tabla branches
 *
 * Esta columna almacena el RFC fiscal de cada sucursal.
 * Permite que cada sucursal tenga su propio RFC para facturacion.
 *
 * Ejecutar: node run_migration_branch_rfc.js
 */

const { pool } = require('./database');

async function runMigration() {
  console.log('='.repeat(60));
  console.log('MIGRACION: Agregar RFC a branches');
  console.log('='.repeat(60));

  try {
    // 1. Verificar si la columna ya existe
    const checkColumn = await pool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'branches' AND column_name = 'rfc'
    `);

    if (checkColumn.rows.length > 0) {
      console.log('La columna RFC ya existe en la tabla branches');
    } else {
      // 2. Agregar la columna
      console.log('Agregando columna RFC a tabla branches...');
      await pool.query(`
        ALTER TABLE branches
        ADD COLUMN rfc VARCHAR(20)
      `);
      console.log('Columna RFC agregada exitosamente');
    }

    // 3. Mostrar estructura actual de branches
    const structure = await pool.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'branches'
      ORDER BY ordinal_position
    `);

    console.log('\nEstructura actual de tabla branches:');
    console.log('-'.repeat(50));
    structure.rows.forEach(row => {
      console.log(`  ${row.column_name}: ${row.data_type} (nullable: ${row.is_nullable})`);
    });

    // 4. Mostrar estadisticas
    const stats = await pool.query(`
      SELECT
        COUNT(*) as total_branches,
        COUNT(rfc) as with_rfc
      FROM branches
    `);

    console.log('\nEstadisticas:');
    console.log('-'.repeat(50));
    console.log(`  Total sucursales: ${stats.rows[0].total_branches}`);
    console.log(`  Con RFC: ${stats.rows[0].with_rfc}`);

    console.log('\nMigracion completada exitosamente');

  } catch (error) {
    console.error('Error en migracion:', error.message);
    throw error;
  } finally {
    await pool.end();
  }
}

runMigration();
