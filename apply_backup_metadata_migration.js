// Aplicar migración 007: backup_metadata
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  host: 'dpg-d3i8dv3e5dus738tm5rg-a.oregon-postgres.render.com',
  user: 'sya_admin',
  password: 'qJ1haIaPp7m7OFMyicWSplPlGoNL1GpF',
  database: 'sya_db_oe4v',
  port: 5432,
  ssl: { rejectUnauthorized: false }
});

async function applyMigration() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('MIGRACIÓN 007: Sistema de Backup en la Nube');
  console.log('═══════════════════════════════════════════════════════════════\n');

  try {
    // Leer archivo SQL
    const sqlPath = path.join(__dirname, 'migrations', '007_add_backup_metadata.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');

    console.log('📊 Ejecutando migración...\n');

    // Ejecutar migración
    await pool.query(sql);

    console.log('✅ Migración ejecutada exitosamente\n');

    // Verificar tabla creada
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('✅ VERIFICACIÓN');
    console.log('═══════════════════════════════════════════════════════════════\n');

    const tableInfo = await pool.query(`
      SELECT
        column_name,
        data_type,
        character_maximum_length,
        is_nullable,
        column_default
      FROM information_schema.columns
      WHERE table_name = 'backup_metadata'
      ORDER BY ordinal_position
    `);

    console.log('Columnas de backup_metadata:\n');
    tableInfo.rows.forEach((col, i) => {
      console.log(`${i + 1}. ${col.column_name}`);
      console.log(`   Tipo: ${col.data_type}`);
      console.log(`   Nullable: ${col.is_nullable}`);
      if (col.column_default) {
        console.log(`   Default: ${col.column_default}`);
      }
      console.log('');
    });

    // Verificar índices
    const indexInfo = await pool.query(`
      SELECT
        indexname,
        indexdef
      FROM pg_indexes
      WHERE tablename = 'backup_metadata'
    `);

    console.log('═══════════════════════════════════════════════════════════════');
    console.log('📚 ÍNDICES CREADOS');
    console.log('═══════════════════════════════════════════════════════════════\n');

    indexInfo.rows.forEach((idx, i) => {
      console.log(`${i + 1}. ${idx.indexname}`);
      console.log(`   ${idx.indexdef}\n`);
    });

    console.log('═══════════════════════════════════════════════════════════════');
    console.log('🎉 MIGRACIÓN COMPLETADA');
    console.log('═══════════════════════════════════════════════════════════════\n');

    console.log('📝 Próximos pasos:');
    console.log('  1. Implementar endpoints de backup en server.js');
    console.log('  2. Crear IntelligentBackupService en Desktop');
    console.log('  3. Configurar backup automático cada 30 minutos');
    console.log('  4. Implementar flujo de restauración desde nube\n');

  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
  } finally {
    await pool.end();
  }
}

applyMigration();
