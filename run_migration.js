const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function runMigration() {
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║   🚀 MIGRACIÓN MULTI-TENANT - SYA TORTILLERÍAS          ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    console.log('⚠️  ADVERTENCIA: Esta migración borrará TODOS los datos existentes');
    console.log('⚠️  Asegúrate de tener un backup si es necesario\n');

    try {
        // Leer archivo SQL
        const migrationPath = path.join(__dirname, 'migrations', '001_multi_tenant_schema.sql');
        console.log(`📂 Leyendo migración: ${migrationPath}\n`);

        const sql = fs.readFileSync(migrationPath, 'utf8');

        // Ejecutar migración
        console.log('🔄 Ejecutando migración...\n');
        const result = await pool.query(sql);

        console.log('✅ Migración ejecutada exitosamente\n');

        // Verificar tablas creadas
        const tables = await pool.query(`
            SELECT tablename
            FROM pg_tables
            WHERE schemaname = 'public'
            ORDER BY tablename
        `);

        console.log(`📊 Tablas creadas (${tables.rows.length}):`);
        tables.rows.forEach((row, index) => {
            console.log(`   ${(index + 1).toString().padStart(2, '0')}. ${row.tablename}`);
        });

        // Verificar planes de suscripción
        console.log('\n💎 Planes de suscripción configurados:');
        const subscriptions = await pool.query('SELECT * FROM subscriptions ORDER BY id');
        subscriptions.rows.forEach(sub => {
            console.log(`   • ${sub.name.padEnd(12)} - $${sub.price_monthly.toString().padStart(7, ' ')} MXN/mes`);
            console.log(`     Max Sucursales: ${sub.max_branches === -1 ? 'ilimitado' : sub.max_branches}`);
            console.log(`     Max Dispositivos: ${sub.max_devices === -1 ? 'ilimitado' : sub.max_devices}`);
            console.log(`     Max Empleados: ${sub.max_employees === -1 ? 'ilimitado' : sub.max_employees}`);
            console.log('');
        });

        console.log('═══════════════════════════════════════════════════════════');
        console.log('✅ Migración completada exitosamente');
        console.log('═══════════════════════════════════════════════════════════\n');

        await pool.end();
        process.exit(0);

    } catch (error) {
        console.error('\n❌ Error ejecutando migración:');
        console.error(error.message);
        console.error('\nStack trace:');
        console.error(error.stack);

        await pool.end();
        process.exit(1);
    }
}

// Ejecutar
runMigration();
