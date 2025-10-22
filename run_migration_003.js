#!/usr/bin/env node

/**
 * Script para ejecutar la migración 003 directamente en PostgreSQL
 * Uso: node run_migration_003.js
 *
 * IMPORTANTE: Este script ejecuta cambios IRREVERSIBLES en la base de datos
 */

const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

const migration = `
BEGIN;

-- 1. ALTER sale_date en tabla sales
ALTER TABLE sales
DROP DEFAULT,
ALTER COLUMN sale_date SET NOT NULL;

-- 2. ALTER expense_date en tabla expenses
ALTER TABLE expenses
DROP DEFAULT,
ALTER COLUMN expense_date SET NOT NULL;

-- 3. ALTER purchase_date en tabla purchases
ALTER TABLE purchases
DROP DEFAULT,
ALTER COLUMN purchase_date SET NOT NULL;

-- 4. ALTER cut_date en tabla cash_cuts
ALTER TABLE cash_cuts
DROP DEFAULT,
ALTER COLUMN cut_date SET NOT NULL;

-- 5. ALTER event_date en tabla guardian_events
ALTER TABLE guardian_events
DROP DEFAULT,
ALTER COLUMN event_date SET NOT NULL;

-- 6. Para registros existentes (que tengan NULL), asignarles el valor actual con UTC
UPDATE sales SET sale_date = CURRENT_TIMESTAMP WHERE sale_date IS NULL;
UPDATE expenses SET expense_date = CURRENT_TIMESTAMP WHERE expense_date IS NULL;
UPDATE purchases SET purchase_date = CURRENT_TIMESTAMP WHERE purchase_date IS NULL;
UPDATE cash_cuts SET cut_date = CURRENT_TIMESTAMP WHERE cut_date IS NULL;
UPDATE guardian_events SET event_date = CURRENT_TIMESTAMP WHERE event_date IS NULL;

COMMIT;
`;

async function runMigration() {
  const client = await pool.connect();

  try {
    console.log('⏳ Iniciando migración 003: Corrección de zonas horarias...');
    console.log('═════════════════════════════════════════════════════════════');

    await client.query(migration);

    console.log('✅ Migración completada exitosamente!');
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
      const hasDefault = row.column_default ? `Default: ${row.column_default}` : '(sin default)';
      console.log(`${row.table_name}.${row.column_name} | ${nullable} | ${hasDefault}`);
    });

    console.log('═════════════════════════════════════════════════════════════');
    console.log('\n✨ MIGRACIÓN EXITOSA - Base de datos configurada correctamente');
    console.log('\nAhora todas las fechas DEBEN venir del cliente con zona horaria.');
    console.log('Si el cliente NO envía la fecha, la inserción fallará (lo cual es correcto).\n');

  } catch (error) {
    console.error('❌ ERROR durante la migración:');
    console.error(error.message);
    console.error('\n⚠️  La base de datos puede estar en un estado inconsistente.');
    console.error('Por favor, revisa manualmente qué pasó.');
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
