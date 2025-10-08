const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function fixSalesTable() {
    try {
        console.log('🔧 Modificando tabla sales...');

        // Hacer employee_id nullable
        await pool.query(`
            ALTER TABLE sales
            ALTER COLUMN employee_id DROP NOT NULL
        `);

        console.log('✅ Columna employee_id ahora permite NULL');

        // Verificar el cambio
        const result = await pool.query(`
            SELECT column_name, is_nullable
            FROM information_schema.columns
            WHERE table_name = 'sales' AND column_name = 'employee_id'
        `);

        console.log('📋 Estado actual:');
        console.log(`  employee_id: ${result.rows[0].is_nullable === 'YES' ? 'nullable ✅' : 'NOT NULL ❌'}`);

        await pool.end();
    } catch (error) {
        console.error('❌ Error:', error.message);
        await pool.end();
        process.exit(1);
    }
}

fixSalesTable();
