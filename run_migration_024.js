#!/usr/bin/env node

/**
 * Migration 024 Runner - Add sync fields to critical tables
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
    console.log('🔄 [Migration 024] Iniciando: Add sync fields to critical tables');
    console.log('📊 Conectado a:', process.env.DATABASE_URL.split('@')[1]);

    const migrationPath = path.join(__dirname, 'migrations', '024_add_sync_fields_to_critical_tables.sql');
    const sql = fs.readFileSync(migrationPath, 'utf8');

    console.log('📝 Ejecutando SQL...');
    await client.query(sql);

    console.log('✅ [Migration 024] Migración completada exitosamente!');
    console.log('\n📋 Campos agregados a tablas principales:');
    console.log('  ✓ employees: remote_id, synced, synced_at');
    console.log('  ✓ suppliers: remote_id, synced, synced_at');
    console.log('  ✓ purchases: remote_id, synced, synced_at');
    console.log('  ✓ sales: remote_id, synced, synced_at (if missing)');
    console.log('  ✓ expenses: remote_id, synced, synced_at (if missing)');
    console.log('  ✓ deposits: remote_id, synced, synced_at (if missing)');
    console.log('  ✓ withdrawals: remote_id, synced, synced_at (if missing)');
    console.log('  ✓ Índices creados para mejor rendimiento en queries de sync');

  } catch (error) {
    console.error('❌ [Migration 024] Error:', error.message);
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
