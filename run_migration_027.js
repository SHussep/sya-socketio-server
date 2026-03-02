#!/usr/bin/env node

/**
 * Migration 027 Runner - Branch inventory + Inter-branch transfers
 *
 * Creates:
 *   - branch_inventory: Per-branch stock tracking
 *   - inventory_transfers: Transfer records between branches
 *   - inventory_transfer_items: Products in each transfer
 *   - Data migration: Populates branch_inventory from existing productos.inventario
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
    console.log('🔄 [Migration 027] Iniciando: Branch inventory + Inter-branch transfers');
    console.log('📊 Conectado a:', process.env.DATABASE_URL.split('@')[1]);

    const migrationPath = path.join(__dirname, 'migrations', '027_branch_inventory_and_transfers.sql');
    const sql = fs.readFileSync(migrationPath, 'utf8');

    console.log('📝 Ejecutando SQL...');
    await client.query(sql);

    // Report results
    const branchInvCount = await client.query('SELECT COUNT(*) FROM branch_inventory');
    const transfersCount = await client.query('SELECT COUNT(*) FROM inventory_transfers');

    console.log('✅ [Migration 027] Migración completada exitosamente!');
    console.log('\n📋 Resultados:');
    console.log(`  ✓ Tabla branch_inventory creada (${branchInvCount.rows[0].count} registros migrados)`);
    console.log('  ✓ Tabla inventory_transfers creada');
    console.log('  ✓ Tabla inventory_transfer_items creada');
    console.log('  ✓ Datos migrados desde productos.inventario');
    console.log('\n📝 Nota: productos.inventario está marcado como DEPRECATED.');
    console.log('  La fuente de verdad ahora es branch_inventory.');

  } catch (error) {
    console.error('❌ [Migration 027] Error:', error.message);
    console.error(error);
    process.exit(1);

  } finally {
    await client.end();
    await pool.end();
    console.log('\n✅ Conexión cerrada');
  }
}

runMigration().catch(err => {
  console.error('❌ Error fatal:', err);
  process.exit(1);
});
