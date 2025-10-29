#!/usr/bin/env node

/**
 * Migration 023 Runner - Create scale_disconnection_logs table
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
    console.log('🔄 [Migration 023] Iniciando: Create scale_disconnection_logs table');
    console.log('📊 Conectado a:', process.env.DATABASE_URL.split('@')[1]);

    const migrationPath = path.join(__dirname, 'migrations', '023_create_scale_disconnection_logs.sql');
    const sql = fs.readFileSync(migrationPath, 'utf8');

    console.log('📝 Ejecutando SQL...');
    await client.query(sql);

    console.log('✅ [Migration 023] Migración completada exitosamente!');
    console.log('\n📋 Tabla creada: scale_disconnection_logs');
    console.log('  ✓ Campos: tenant_id, branch_id, shift_id, employee_id');
    console.log('  ✓ Campos: event_type, severity, disconnection_time, reconnection_time');
    console.log('  ✓ Campos: is_synced, resolution_status');
    console.log('  ✓ Índices para mejor rendimiento');
    console.log('  ✓ Relación con shifts para filtrar por turno');

  } catch (error) {
    console.error('❌ [Migration 023] Error:', error.message);
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
