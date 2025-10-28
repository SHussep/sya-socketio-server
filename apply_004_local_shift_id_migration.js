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
    console.log('║  🔧 MIGRACIÓN 004: Agregar local_shift_id               ║');
    console.log('║  Para offline-first synchronization                      ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    try {
        const migrationPath = path.join(__dirname, 'migrations', '004_add_local_shift_id.sql');
        console.log(`📂 Leyendo migración: ${migrationPath}\n`);

        const sql = fs.readFileSync(migrationPath, 'utf8');

        console.log('🔄 Ejecutando migración...\n');
        await pool.query(sql);

        console.log('✅ Migración ejecutada exitosamente\n');

        console.log('🔍 Verificando cambios en la base de datos...');

        // Verificar que las columnas fueron agregadas
        const shiftsCheck = await pool.query(`
            SELECT column_name
            FROM information_schema.columns
            WHERE table_name = 'shifts' AND column_name = 'local_shift_id'
        `);

        const salesCheck = await pool.query(`
            SELECT column_name
            FROM information_schema.columns
            WHERE table_name = 'sales' AND column_name = 'local_shift_id'
        `);

        const expensesCheck = await pool.query(`
            SELECT column_name
            FROM information_schema.columns
            WHERE table_name = 'expenses' AND column_name = 'local_shift_id'
        `);

        const depositsCheck = await pool.query(`
            SELECT column_name
            FROM information_schema.columns
            WHERE table_name = 'deposits' AND column_name = 'local_shift_id'
        `);

        const withdrawalsCheck = await pool.query(`
            SELECT column_name
            FROM information_schema.columns
            WHERE table_name = 'withdrawals' AND column_name = 'local_shift_id'
        `);

        console.log('\n✅ Columnas creadas:\n');
        console.log(`   ✓ shifts.local_shift_id: ${shiftsCheck.rows.length > 0 ? '✅' : '❌'}`);
        console.log(`   ✓ sales.local_shift_id: ${salesCheck.rows.length > 0 ? '✅' : '❌'}`);
        console.log(`   ✓ expenses.local_shift_id: ${expensesCheck.rows.length > 0 ? '✅' : '❌'}`);
        console.log(`   ✓ deposits.local_shift_id: ${depositsCheck.rows.length > 0 ? '✅' : '❌'}`);
        console.log(`   ✓ withdrawals.local_shift_id: ${withdrawalsCheck.rows.length > 0 ? '✅' : '❌'}`);

        // Verificar índices
        const indexCheck = await pool.query(`
            SELECT indexname
            FROM pg_indexes
            WHERE tablename = 'shifts' AND indexname LIKE '%local_shift_id%'
        `);

        console.log('\n✅ Índices creados:\n');
        console.log(`   ✓ idx_shifts_local_shift_id: ${indexCheck.rows.length > 0 ? '✅' : '❌'}`);

        console.log('\n═══════════════════════════════════════════════════════════');
        console.log('✅ MIGRACIÓN 004 COMPLETADA EXITOSAMENTE');
        console.log('═══════════════════════════════════════════════════════════\n');

        console.log('📝 PRÓXIMAS ACCIONES RECOMENDADAS:');
        console.log('   1. Desktop app ya envía localShiftId en payloads');
        console.log('   2. Backend API ya recibe localShiftId');
        console.log('   3. Sistema offline-first ahora está operativo');
        console.log('   4. Prueba abriendo/cerrando turno offline\n');

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
