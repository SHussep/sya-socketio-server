const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function applyMigration() {
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║   🔧 MIGRACIÓN 014: Agregar max_devices_per_branch     ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    try {
        const migrationPath = path.join(__dirname, 'migrations', '014_add_max_devices_per_branch.sql');
        console.log(`📂 Leyendo migración: ${migrationPath}\n`);

        const sql = fs.readFileSync(migrationPath, 'utf8');

        console.log('🔄 Ejecutando migración...\n');
        await pool.query(sql);

        console.log('✅ Migración ejecutada exitosamente\n');

        console.log('🔍 Verificando planes de suscripción...');
        const result = await pool.query(`
            SELECT id, name, max_branches, max_employees, max_devices_per_branch
            FROM subscriptions
            ORDER BY id
        `);

        if (result.rows.length > 0) {
            console.log('✅ Planes de suscripción actualizados:\n');
            result.rows.forEach((plan, index) => {
                console.log(`   ${(index + 1)}. ${plan.name.padEnd(15)} - Sucursales: ${plan.max_branches}, Empleados: ${plan.max_employees}, Dispositivos/Sucursal: ${plan.max_devices_per_branch}`);
            });
        }

        console.log('\n═══════════════════════════════════════════════════════════');
        console.log('✅ Migración 014 completada exitosamente');
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

applyMigration();
