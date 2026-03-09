#!/usr/bin/env node

/**
 * Migration 022 Runner - Add shift_id foreign key relationships
 * Ejecuta la migración 022 en la base de datos PostgreSQL de producción
 */

require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Necesario para Render.com
});

async function runMigration() {
  const client = await pool.connect();

  try {
    console.log('🔄 [Migration 022] Iniciando migración: Add shift_id foreign key relationships');
    console.log('📊 Conectado a:', process.env.DATABASE_URL.split('@')[1]);

    // Leer el archivo SQL
    const migrationPath = path.join(__dirname, 'migrations', '022_add_shift_id_foreign_keys.sql');
    const sql = fs.readFileSync(migrationPath, 'utf8');

    console.log('📝 Ejecutando SQL...');

    // Ejecutar la migración
    await client.query(sql);

    console.log('✅ [Migration 022] Migración completada exitosamente!');
    console.log('\n📋 Cambios realizados:');
    console.log('  ✓ Agregado shift_id a tabla sales');
    console.log('  ✓ Agregado shift_id a tabla expenses');
    console.log('  ✓ Agregado shift_id a tabla deposits');
    console.log('  ✓ Agregado shift_id a tabla withdrawals');
    console.log('  ✓ Agregado shift_id a tabla cash_cuts');
    console.log('  ✓ Creados índices para rendimiento');
    console.log('  ✓ Configuradas relaciones con cascading delete');

  } catch (error) {
    console.error('❌ [Migration 022] Error durante migración:', error.message);
    console.error('\n📍 Detalles del error:');
    console.error(error);
    process.exit(1);

  } finally {
    await client.end();
    await pool.end();
    console.log('\n✅ Conexión cerrada');
  }
}

// Ejecutar
runMigration().catch(err => {
  console.error('❌ Error fatal:', err);
  process.exit(1);
});
