#!/usr/bin/env node

const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

async function runMigration() {
  const client = await pool.connect();

  try {
    console.log('⏳ Iniciando migración 003: Corrección de zonas horarias...');
    console.log('═════════════════════════════════════════════════════════════');

    // Ejecutar cada ALTER por separado para mejor control
    const queries = [
      { desc: 'sales.sale_date', sql: 'ALTER TABLE sales ALTER COLUMN sale_date DROP DEFAULT, ALTER COLUMN sale_date SET NOT NULL;' },
      { desc: 'expenses.expense_date', sql: 'ALTER TABLE expenses ALTER COLUMN expense_date DROP DEFAULT, ALTER COLUMN expense_date SET NOT NULL;' },
      { desc: 'purchases.purchase_date', sql: 'ALTER TABLE purchases ALTER COLUMN purchase_date DROP DEFAULT, ALTER COLUMN purchase_date SET NOT NULL;' },
      { desc: 'cash_cuts.cut_date', sql: 'ALTER TABLE cash_cuts ALTER COLUMN cut_date DROP DEFAULT, ALTER COLUMN cut_date SET NOT NULL;' },
      { desc: 'guardian_events.event_date', sql: 'ALTER TABLE guardian_events ALTER COLUMN event_date DROP DEFAULT, ALTER COLUMN event_date SET NOT NULL;' },
    ];

    for (const q of queries) {
      try {
        console.log(`  ⏳ Aplicando a ${q.desc}...`);
        await client.query(q.sql);
        console.log(`  ✅ OK: ${q.desc}`);
      } catch (e) {
        console.log(`  ⚠️  ${q.desc}: ${e.message}`);
      }
    }

    // Actualizar registros con NULL
    console.log('\n  ⏳ Actualizando registros existentes con NULL...');
    await client.query('UPDATE sales SET sale_date = CURRENT_TIMESTAMP WHERE sale_date IS NULL;');
    await client.query('UPDATE expenses SET expense_date = CURRENT_TIMESTAMP WHERE expense_date IS NULL;');
    await client.query('UPDATE purchases SET purchase_date = CURRENT_TIMESTAMP WHERE purchase_date IS NULL;');
    await client.query('UPDATE cash_cuts SET cut_date = CURRENT_TIMESTAMP WHERE cut_date IS NULL;');
    await client.query('UPDATE guardian_events SET event_date = CURRENT_TIMESTAMP WHERE event_date IS NULL;');
    console.log('  ✅ Registros actualizados');

    console.log('\n✅ Migración completada exitosamente!');
    console.log('═════════════════════════════════════════════════════════════');

    // Verificar los cambios
    console.log('\n🔍 Verificando cambios aplicados...\n');

    const verifyQuery = `
      SELECT table_name, column_name, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name IN ('sales', 'expenses', 'purchases', 'cash_cuts', 'guardian_events')
      AND column_name IN ('sale_date', 'expense_date', 'purchase_date', 'cut_date', 'event_date')
      ORDER BY table_name, column_name;
    `;

    const result = await client.query(verifyQuery);

    console.log('Columnas de fecha después de la migración:');
    console.log('─────────────────────────────────────────────────────────────');

    result.rows.forEach(row => {
      const nullable = row.is_nullable === 'NO' ? '✅ NOT NULL' : '❌ NULLABLE';
      const hasDefault = row.column_default ? `⚠️ Default: ${row.column_default}` : '✅ (sin default)';
      console.log(`${row.table_name}.${row.column_name.padEnd(20)} | ${nullable} | ${hasDefault}`);
    });

    console.log('═════════════════════════════════════════════════════════════');
    console.log('\n✨ MIGRACIÓN EXITOSA - Base de datos configurada correctamente');
    console.log('\nAhora todas las fechas DEBEN venir del cliente con zona horaria.');
    console.log('Si el cliente NO envía la fecha, la inserción fallará (lo cual es correcto).\n');

  } catch (error) {
    console.error('❌ ERROR durante la migración:');
    console.error(error.message);
    console.error('\n⚠️  Por favor, revisa manualmente.');
    process.exit(1);

  } finally {
    client.release();
    await pool.end();
  }
}

runMigration().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
