#!/usr/bin/env node

/**
 * Migration 018 Runner - Triggers para Notas de Crédito: Saldo Cliente e Inventario
 *
 * Este script ejecuta los triggers para:
 * 1. Actualizar saldo_deudor del cliente cuando se aplica NC a venta a crédito
 * 2. Actualizar inventario de productos cuando devuelve_a_inventario = TRUE
 * 3. Actualizar inventario en devoluciones de repartidor
 * 4. Revertir saldo si se anula una nota de crédito
 */

require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function runMigration() {
  const client = await pool.connect();

  try {
    console.log('╔══════════════════════════════════════════════════════════════════════╗');
    console.log('║  🔄 Migration 018 - Triggers Notas de Crédito: Saldo e Inventario   ║');
    console.log('╚══════════════════════════════════════════════════════════════════════╝\n');
    console.log('📊 Conectado a:', process.env.DATABASE_URL.split('@')[1]);

    const migrationPath = path.join(__dirname, 'migrations', '018_triggers_notas_credito_inventory_balance.sql');
    const sql = fs.readFileSync(migrationPath, 'utf8');

    console.log('📝 Ejecutando SQL...\n');
    await client.query(sql);

    console.log('✅ [Migration 018] Migración completada exitosamente!\n');
    console.log('📋 Triggers creados:');
    console.log('  ✓ trigger_update_balance_on_nota_credito');
    console.log('    → Reduce saldo_deudor del cliente cuando NC se aplica a venta a crédito');
    console.log('');
    console.log('  ✓ trigger_update_inventory_on_nc_detalle');
    console.log('    → Aumenta inventario cuando detalle de NC tiene devuelve_a_inventario=TRUE');
    console.log('');
    console.log('  ✓ trigger_update_inventory_on_repartidor_return');
    console.log('    → Aumenta inventario cuando repartidor registra devolución confirmada');
    console.log('    → Revierte inventario si se elimina devolución previamente confirmada');
    console.log('');
    console.log('  ✓ trigger_revert_balance_on_nc_cancel');
    console.log('    → Revierte saldo_deudor si se anula una NC previamente aplicada');

  } catch (error) {
    console.error('❌ [Migration 018] Error:', error.message);
    console.error(error);
    process.exit(1);

  } finally {
    await client.release();
    await pool.end();
    console.log('\n✅ Conexión cerrada');
  }
}

runMigration().catch(err => {
  console.error('❌ Error fatal:', err);
  process.exit(1);
});
