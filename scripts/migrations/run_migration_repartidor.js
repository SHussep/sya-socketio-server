#!/usr/bin/env node

/**
 * Script para ejecutar la migración de tablas de repartidor
 * Uso: node run_migration_repartidor.js
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config();
const { pool } = require('./database');

async function runMigration() {
  console.log('📋 Iniciando migración de tablas de repartidor...\n');

  try {
    // Leer el archivo de migración
    const migrationFile = path.join(__dirname, 'MIGRATION_REPARTIDOR_ASSIGNMENTS.sql');

    if (!fs.existsSync(migrationFile)) {
      console.error('❌ Error: No se encontró archivo de migración:', migrationFile);
      process.exit(1);
    }

    const migrationSQL = fs.readFileSync(migrationFile, 'utf8');
    console.log('✅ Archivo de migración cargado');
    console.log(`📊 Tamaño: ${(migrationSQL.length / 1024).toFixed(2)} KB\n`);

    // Conectar a la base de datos
    console.log('🔗 Conectando a PostgreSQL...');
    const client = await pool.connect();
    console.log('✅ Conexión establecida\n');

    // Ejecutar la migración
    console.log('⏳ Ejecutando SQL de migración...');
    await client.query(migrationSQL);
    console.log('✅ Migración ejecutada exitosamente\n');

    // Verificar que las tablas fueron creadas
    console.log('🔍 Verificando tablas creadas...\n');

    const tablesQuery = `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_name LIKE 'repartidor%'
      ORDER BY table_name;
    `;

    const result = await client.query(tablesQuery);

    if (result.rows.length === 0) {
      console.log('⚠️  No se encontraron tablas de repartidor');
      client.release();
      process.exit(1);
    }

    console.log('Tablas creadas:');
    result.rows.forEach(row => {
      console.log(`  ✅ ${row.table_name}`);
    });
    console.log();

    // Contar registros en cada tabla
    console.log('📊 Conteo de registros:\n');

    for (const table of ['repartidor_assignments', 'repartidor_liquidations', 'repartidor_debts']) {
      try {
        const countResult = await client.query(`SELECT COUNT(*) as count FROM ${table};`);
        const count = countResult.rows[0].count;
        console.log(`  ${table}: ${count} registros`);
      } catch (error) {
        console.log(`  ${table}: Error al contar (tabla podría estar vacía)`);
      }
    }

    console.log();

    // Verificar índices
    console.log('🔑 Verificando índices:\n');

    const indexQuery = `
      SELECT indexname, tablename
      FROM pg_indexes
      WHERE tablename LIKE 'repartidor%'
      ORDER BY tablename, indexname;
    `;

    const indexResult = await client.query(indexQuery);

    if (indexResult.rows.length > 0) {
      console.log('Índices creados:');
      indexResult.rows.forEach(row => {
        console.log(`  ✅ ${row.indexname} en tabla ${row.tablename}`);
      });
    } else {
      console.log('⚠️  No se encontraron índices');
    }

    console.log();

    // Resumen final
    console.log('╔════════════════════════════════════════════════════════╗');
    console.log('║     ✅ MIGRACIÓN COMPLETADA EXITOSAMENTE              ║');
    console.log('╚════════════════════════════════════════════════════════╝\n');

    console.log('Próximos pasos:');
    console.log('1. ✅ Migración SQL ejecutada');
    console.log('2. ⏳ Compilar Desktop (C#) para incluir modelos nuevos');
    console.log('3. ⏳ Instalar Mobile (Flutter) y probar asignaciones');
    console.log('4. ⏳ Ejecutar pruebas end-to-end\n');

    client.release();
    process.exit(0);

  } catch (error) {
    console.error('❌ Error durante la migración:');
    console.error(error.message);
    console.error('\nDetalles:');
    console.error(error);
    process.exit(1);
  }
}

// Ejecutar migración
runMigration().catch(error => {
  console.error('❌ Error fatal:', error);
  process.exit(1);
});
