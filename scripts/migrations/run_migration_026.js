#!/usr/bin/env node

/**
 * Migration 026 Runner - Remove unnecessary sync fields from PostgreSQL
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
    console.log('🔄 [Migration 026] Iniciando: Remove unnecessary sync fields from PostgreSQL');
    console.log('📊 Conectado a:', process.env.DATABASE_URL.split('@')[1]);

    const migrationPath = path.join(__dirname, 'migrations', '026_remove_unnecessary_sync_fields.sql');
    const sql = fs.readFileSync(migrationPath, 'utf8');

    console.log('📝 Ejecutando SQL...');
    await client.query(sql);

    console.log('✅ [Migration 026] Migración completada exitosamente!');
    console.log('\n📋 Cambios realizados:');
    console.log('  ✓ Eliminados campos remote_id, synced, synced_at de employees');
    console.log('  ✓ Eliminados campos remote_id, synced, synced_at de suppliers');
    console.log('  ✓ Eliminados campos remote_id, synced, synced_at de purchases');
    console.log('  ✓ Eliminados campos remote_id, synced, synced_at de sales');
    console.log('  ✓ Eliminados campos remote_id, synced, synced_at de expenses');
    console.log('  ✓ Eliminados campos remote_id, synced, synced_at de deposits');
    console.log('  ✓ Eliminados campos remote_id, synced, synced_at de withdrawals');
    console.log('  ✓ Eliminados campos remote_id, synced, synced_at de branches');
    console.log('  ✓ Eliminados campos remote_id, synced, synced_at de tenants');
    console.log('\n📝 Nota: Los campos sync (RemoteId, Synced, SyncedAt) están disponibles en Desktop SQLite local');
    console.log('  para rastrear sincronización. PostgreSQL es la fuente de verdad y no necesita estos campos.');

  } catch (error) {
    console.error('❌ [Migration 026] Error:', error.message);
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
