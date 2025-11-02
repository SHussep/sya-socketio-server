#!/usr/bin/env node

/**
 * Inspector de esquema PostgreSQL
 * Verifica qué tablas existen y sus campos
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function inspectSchema() {
  const client = await pool.connect();

  try {
    console.log('📊 INSPECCIONANDO ESQUEMA POSTGRESQL');
    console.log('═══════════════════════════════════════════════════════════\n');

    // Obtener todas las tablas
    const tablesResult = await client.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name;
    `);

    const tables = tablesResult.rows.map(row => row.table_name);
    console.log(`✓ Tablas encontradas (${tables.length}):`);
    tables.forEach(table => console.log(`  • ${table}`));

    console.log('\n═══════════════════════════════════════════════════════════\n');

    // Tablas críticas para shift filtering
    const criticalTables = ['shifts', 'sales', 'expenses', 'deposits', 'withdrawals', 'scale_disconnection_logs', 'cash_cuts'];

    for (const tableName of criticalTables) {
      if (tables.includes(tableName)) {
        console.log(`✅ TABLA: ${tableName.toUpperCase()}`);

        const columnsResult = await client.query(`
          SELECT column_name, data_type, is_nullable
          FROM information_schema.columns
          WHERE table_name = $1
          ORDER BY ordinal_position;
        `, [tableName]);

        columnsResult.rows.forEach(col => {
          const nullable = col.is_nullable === 'YES' ? '(nullable)' : '(NOT NULL)';
          console.log(`  • ${col.column_name}: ${col.data_type} ${nullable}`);
        });

        console.log();
      } else {
        console.log(`❌ TABLA FALTANTE: ${tableName.toUpperCase()}`);
        console.log('   ⚠️  Esta tabla NO existe en PostgreSQL!\n');
      }
    }

    console.log('═══════════════════════════════════════════════════════════\n');
    console.log('RESUMEN:');
    console.log(`  Shifts existe: ${tables.includes('shifts') ? '✅' : '❌'}`);
    console.log(`  Sales existe: ${tables.includes('sales') ? '✅' : '❌'}`);
    console.log(`  Expenses existe: ${tables.includes('expenses') ? '✅' : '❌'}`);
    console.log(`  Deposits existe: ${tables.includes('deposits') ? '✅' : '❌'}`);
    console.log(`  Withdrawals existe: ${tables.includes('withdrawals') ? '✅' : '❌'}`);
    console.log(`  Scale_disconnection_logs existe: ${tables.includes('scale_disconnection_logs') ? '✅' : '❌'}`);
    console.log(`  Cash_cuts existe: ${tables.includes('cash_cuts') ? '✅' : '❌'}`);

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);

  } finally {
    await client.end();
    await pool.end();
  }
}

inspectSchema().catch(err => {
  console.error('❌ Error fatal:', err);
  process.exit(1);
});
