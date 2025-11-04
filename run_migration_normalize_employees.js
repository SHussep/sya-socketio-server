// ========================================================================
// Script para ejecutar migración: Normalización de Employees (3NF)
// ========================================================================

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// Configuración de PostgreSQL desde variables de entorno
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function runMigration() {
    const client = await pool.connect();
    try {
        console.log('🔄 Iniciando migración: Normalización de Employees...\n');

        // Leer el archivo SQL
        const sqlPath = path.join(__dirname, 'migrations', '003_normalize_employees.sql');
        const sql = fs.readFileSync(sqlPath, 'utf8');

        // Ejecutar la migración
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('COMMIT');

        console.log('✅ Migración completada exitosamente!\n');
        console.log('Cambios aplicados:');
        console.log('  ✓ address y phone_number agregados a employees');
        console.log('  ✓ is_active eliminado de employee_branches (redundante)');
        console.log('  ✓ CASCADE DELETE configurado para employee_branches');
        console.log('  ✓ Índices creados para mejor performance\n');

        // Verificar los cambios
        console.log('🔍 Verificando estructura de employees...');
        const employeesColumns = await client.query(`
            SELECT column_name, data_type
            FROM information_schema.columns
            WHERE table_name = 'employees'
            AND column_name IN ('address', 'phone_number')
            ORDER BY column_name;
        `);
        console.log('Columnas agregadas:', employeesColumns.rows);

        console.log('\n🔍 Verificando estructura de employee_branches...');
        const branchesColumns = await client.query(`
            SELECT column_name
            FROM information_schema.columns
            WHERE table_name = 'employee_branches'
            AND column_name = 'is_active';
        `);
        if (branchesColumns.rows.length === 0) {
            console.log('✓ is_active eliminado exitosamente de employee_branches');
        } else {
            console.log('⚠️  is_active todavía existe en employee_branches');
        }

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ Error ejecutando migración:', error.message);
        console.error('Stack:', error.stack);
        process.exit(1);
    } finally {
        client.release();
        await pool.end();
    }
}

// Ejecutar migración
runMigration().catch(console.error);
