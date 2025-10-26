const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function checkColumnType() {
    try {
        const result = await pool.query(`
            SELECT column_name, data_type, udt_name
            FROM information_schema.columns
            WHERE table_name = 'sales' AND column_name = 'sale_date'
        `);

        console.log('\n═════════════════════════════════════════');
        console.log('VERIFICACIÓN DE TIPO DE COLUMNA: sale_date');
        console.log('═════════════════════════════════════════\n');

        if (result.rows.length === 0) {
            console.log('❌ Columna sale_date NO ENCONTRADA');
        } else {
            const row = result.rows[0];
            console.log(`Column Name: ${row.column_name}`);
            console.log(`Data Type: ${row.data_type}`);
            console.log(`UDT Name: ${row.udt_name}`);

            if (row.data_type === 'timestamp with time zone') {
                console.log('\n✅ CORRECTO: La columna ES TIMESTAMP WITH TIME ZONE');
            } else if (row.data_type === 'timestamp without time zone') {
                console.log('\n❌ ERROR: La columna SIGUE SIENDO TIMESTAMP WITHOUT TIME ZONE');
                console.log('   Las migraciones 020/021 NO funcionaron correctamente');
            } else {
                console.log(`\n⚠️  TIPO INESPERADO: ${row.data_type}`);
            }
        }

        console.log('\n═════════════════════════════════════════\n');

        // También verificar una venta reciente
        console.log('Últimas 3 ventas guardadas:\n');
        const salesResult = await pool.query(`
            SELECT id, sale_date, sale_date::TEXT as sale_date_text
            FROM sales
            ORDER BY id DESC
            LIMIT 3
        `);

        salesResult.rows.forEach((row, index) => {
            console.log(`[${index + 1}] ID: ${row.id}`);
            console.log(`    sale_date: ${row.sale_date}`);
            console.log(`    sale_date (TEXT): ${row.sale_date_text}`);
            console.log();
        });

    } catch (error) {
        console.error('❌ Error:', error.message);
    } finally {
        await pool.end();
    }
}

checkColumnType();
