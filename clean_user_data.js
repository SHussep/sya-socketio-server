const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function cleanUserData() {
    console.log('╔══════════════════════════════════════════════════════════════════╗');
    console.log('║   🧹 LIMPIEZA: Eliminar datos de usuarios                      ║');
    console.log('║   ⚠️  ADVERTENCIA: Esto eliminará TODOS los datos de usuarios  ║');
    console.log('╚══════════════════════════════════════════════════════════════════╝\n');

    try {
        const migrationPath = path.join(__dirname, 'migrations', '999_clean_user_data.sql');
        console.log(`📂 Leyendo script de limpieza: ${migrationPath}\n`);

        const sql = fs.readFileSync(migrationPath, 'utf8');

        console.log('⏳ Esperando 3 segundos antes de ejecutar la limpieza...\n');
        await new Promise(resolve => setTimeout(resolve, 3000));

        console.log('🔄 Ejecutando limpieza de datos...\n');
        const result = await pool.query(sql);

        console.log('✅ Limpieza ejecutada exitosamente\n');

        // Mostrar resultados de las consultas SELECT del script
        if (result && Array.isArray(result)) {
            const summaryResult = result.find(r => r.command === 'SELECT' && r.rows && r.rows.length > 0);
            if (summaryResult) {
                console.log('📊 Resumen de limpieza:');
                summaryResult.rows.forEach(row => {
                    console.log(JSON.stringify(row, null, 2));
                });
            }
        }

        console.log('\n═══════════════════════════════════════════════════════════');
        console.log('✅ Limpieza completada exitosamente');
        console.log('   - Tablas de usuarios vaciadas');
        console.log('   - Secuencias de IDs reseteadas a 1');
        console.log('   - Tablas maestras (subscriptions) preservadas');
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

cleanUserData();
