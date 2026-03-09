// Limpiar metadata de backups viejos que ya no existen en Dropbox
require('dotenv').config();
const { pool } = require('./database');

async function cleanup() {
    try {
        console.log('🧹 Limpiando metadata de backups viejos...\n');

        // Eliminar TODOS los backups antiguos de la base de datos
        const result = await pool.query(`
            DELETE FROM backup_metadata
            WHERE backup_filename NOT LIKE 'SYA_Backup_Branch_%'
            RETURNING id, tenant_id, branch_id, backup_filename
        `);

        console.log(`✅ Eliminados ${result.rows.length} registros de backups antiguos:\n`);

        for (const row of result.rows) {
            console.log(`   - ID: ${row.id}, Tenant: ${row.tenant_id}, Branch: ${row.branch_id}`);
            console.log(`     Archivo: ${row.backup_filename}\n`);
        }

        // Mostrar backups actuales
        const currentBackups = await pool.query(`
            SELECT id, tenant_id, branch_id, backup_filename, created_at
            FROM backup_metadata
            ORDER BY created_at DESC
        `);

        console.log(`📦 Backups actuales en la base de datos: ${currentBackups.rows.length}\n`);

        for (const backup of currentBackups.rows) {
            console.log(`   - ID: ${backup.id}, Tenant: ${backup.tenant_id}, Branch: ${backup.branch_id}`);
            console.log(`     Archivo: ${backup.backup_filename}`);
            console.log(`     Fecha: ${backup.created_at}\n`);
        }

        console.log('✅ Limpieza completada\n');
        console.log('💡 Ahora crea un nuevo backup desde la app Desktop para sincronizar.');

        process.exit(0);
    } catch (error) {
        console.error('❌ Error:', error.message);
        process.exit(1);
    }
}

cleanup();
