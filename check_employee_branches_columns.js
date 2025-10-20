const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

(async () => {
    try {
        const result = await pool.query(`
            SELECT column_name, data_type, column_default
            FROM information_schema.columns
            WHERE table_name = 'employee_branches'
            ORDER BY ordinal_position
        `);

        console.log('Columnas de employee_branches:');
        result.rows.forEach(col => {
            console.log(`  - ${col.column_name} (${col.data_type}) DEFAULT ${col.column_default || 'N/A'}`);
        });

        await pool.end();
    } catch (error) {
        console.error('Error:', error.message);
        await pool.end();
    }
})();
