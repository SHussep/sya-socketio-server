require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL
});

async function cleanup() {
    try {
        console.log('🧹 Iniciando limpieza de datos...\n');
        console.log('📍 Conectando a:', process.env.DATABASE_URL.split('@')[1]);

        // Desactivar constraints
        console.log('\n⏸️  Desactivando constraints...');
        await pool.query('ALTER TABLE sales_items DISABLE TRIGGER ALL');
        await pool.query('ALTER TABLE sales DISABLE TRIGGER ALL');
        await pool.query('ALTER TABLE expenses DISABLE TRIGGER ALL');
        await pool.query('ALTER TABLE cash_cuts DISABLE TRIGGER ALL');
        await pool.query('ALTER TABLE guardian_events DISABLE TRIGGER ALL');
        await pool.query('ALTER TABLE shifts DISABLE TRIGGER ALL');

        // Borrar datos
        console.log('🗑️  Borrando datos de transacciones...');
        
        const result1 = await pool.query('DELETE FROM sales_items');
        console.log(`   ✅ Eliminados ${result1.rowCount} registros de sales_items`);

        const result2 = await pool.query('DELETE FROM sales');
        console.log(`   ✅ Eliminados ${result2.rowCount} registros de sales`);

        const result3 = await pool.query('DELETE FROM expenses');
        console.log(`   ✅ Eliminados ${result3.rowCount} registros de expenses`);

        const result4 = await pool.query('DELETE FROM cash_cuts');
        console.log(`   ✅ Eliminados ${result4.rowCount} registros de cash_cuts`);

        const result5 = await pool.query('DELETE FROM guardian_events');
        console.log(`   ✅ Eliminados ${result5.rowCount} registros de guardian_events`);

        const result6 = await pool.query('DELETE FROM shifts');
        console.log(`   ✅ Eliminados ${result6.rowCount} registros de shifts`);

        // Reactivar constraints
        console.log('\n▶️  Reactivando constraints...');
        await pool.query('ALTER TABLE sales_items ENABLE TRIGGER ALL');
        await pool.query('ALTER TABLE sales ENABLE TRIGGER ALL');
        await pool.query('ALTER TABLE expenses ENABLE TRIGGER ALL');
        await pool.query('ALTER TABLE cash_cuts ENABLE TRIGGER ALL');
        await pool.query('ALTER TABLE guardian_events ENABLE TRIGGER ALL');
        await pool.query('ALTER TABLE shifts ENABLE TRIGGER ALL');

        // Reset sequences
        console.log('\n🔄 Reiniciando secuencias...');
        await pool.query('ALTER SEQUENCE sales_id_seq RESTART WITH 1');
        await pool.query('ALTER SEQUENCE sales_items_id_seq RESTART WITH 1');
        await pool.query('ALTER SEQUENCE expenses_id_seq RESTART WITH 1');
        await pool.query('ALTER SEQUENCE cash_cuts_id_seq RESTART WITH 1');
        await pool.query('ALTER SEQUENCE guardian_events_id_seq RESTART WITH 1');
        await pool.query('ALTER SEQUENCE shifts_id_seq RESTART WITH 1');

        // Verificar limpieza
        console.log('\n📊 Verificando limpieza...');
        const verify = await pool.query(`
            SELECT 
                (SELECT COUNT(*) FROM sales) as sales_count,
                (SELECT COUNT(*) FROM sales_items) as sales_items_count,
                (SELECT COUNT(*) FROM expenses) as expenses_count,
                (SELECT COUNT(*) FROM cash_cuts) as cash_cuts_count,
                (SELECT COUNT(*) FROM guardian_events) as guardian_events_count,
                (SELECT COUNT(*) FROM shifts) as shifts_count
        `);

        const data = verify.rows[0];
        console.log(`   sales: ${data.sales_count}`);
        console.log(`   sales_items: ${data.sales_items_count}`);
        console.log(`   expenses: ${data.expenses_count}`);
        console.log(`   cash_cuts: ${data.cash_cuts_count}`);
        console.log(`   guardian_events: ${data.guardian_events_count}`);
        console.log(`   shifts: ${data.shifts_count}`);

        // Verificar maestros intactos
        console.log('\n✅ Verificando datos maestros (deben estar intactos)...');
        const masters = await pool.query(`
            SELECT 
                'Tenants' as tabla, COUNT(*) as count FROM tenants
            UNION ALL
            SELECT 'Branches', COUNT(*) FROM branches
            UNION ALL
            SELECT 'Employees', COUNT(*) FROM employees
            UNION ALL
            SELECT 'Subscriptions', COUNT(*) FROM subscriptions
        `);

        masters.rows.forEach(row => {
            console.log(`   ${row.tabla}: ${row.count} registros`);
        });

        console.log('\n✅ ¡Limpieza completada exitosamente!');
        await pool.end();
        process.exit(0);

    } catch (error) {
        console.error('❌ Error durante la limpieza:', error.message);
        await pool.end();
        process.exit(1);
    }
}

cleanup();
