// Script para limpiar la base de datos PostgreSQL
require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

async function cleanupDatabase() {
    const client = await pool.connect();

    try {
        console.log('🔄 Conectado a PostgreSQL...');

        // Leer el script SQL
        const sql = fs.readFileSync('./cleanup_database.sql', 'utf8');

        console.log('⚠️  ADVERTENCIA: Este script eliminará TODOS los datos de tenants, branches y employees');
        console.log('⏳ Esperando 3 segundos antes de continuar...\n');

        await new Promise(resolve => setTimeout(resolve, 3000));

        // Ejecutar el script
        console.log('🗑️  Ejecutando limpieza...');
        await client.query(sql);

        console.log('\n✅ Base de datos limpiada exitosamente\n');

        // Verificar
        const result = await client.query(`
            SELECT 'Tenants restantes:' as descripcion, COUNT(*) as total FROM tenants
            UNION ALL
            SELECT 'Branches restantes:', COUNT(*) FROM branches
            UNION ALL
            SELECT 'Employees restantes:', COUNT(*) FROM employees
            UNION ALL
            SELECT 'Backups restantes:', COUNT(*) FROM backup_metadata
        `);

        console.log('📊 Estado actual:');
        result.rows.forEach(row => {
            console.log(`   ${row.descripcion} ${row.total}`);
        });

    } catch (error) {
        console.error('❌ Error durante la limpieza:', error.message);
        console.error(error);
    } finally {
        client.release();
        await pool.end();
    }
}

cleanupDatabase();
