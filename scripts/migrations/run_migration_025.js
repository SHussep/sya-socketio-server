#!/usr/bin/env node

/**
 * Migration 025 Runner - Add sync fields to Branch and Tenant tables
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
    console.log('🔄 [Migration 025] Iniciando: Add sync fields to Branch and Tenant tables');
    console.log('📊 Conectado a:', process.env.DATABASE_URL.split('@')[1]);

    const migrationPath = path.join(__dirname, 'migrations', '025_add_sync_fields_to_branch_tenant.sql');
    const sql = fs.readFileSync(migrationPath, 'utf8');

    console.log('📝 Ejecutando SQL...');
    await client.query(sql);

    console.log('✅ [Migration 025] Migración completada exitosamente!');
    console.log('\n📋 Campos agregados:');
    console.log('  ✓ branches: remote_id, synced, synced_at');
    console.log('  ✓ tenants: remote_id, synced, synced_at');
    console.log('  ✓ Índices creados para mejor rendimiento en queries de sync');

  } catch (error) {
    console.error('❌ [Migration 025] Error:', error.message);
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
