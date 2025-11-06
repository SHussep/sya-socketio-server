const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

(async () => {
    const client = await pool.connect();
    try {
        console.log('🔍 Estructura de la tabla tenants:\n');

        const structure = await client.query(`
            SELECT column_name, data_type, is_nullable, column_default
            FROM information_schema.columns
            WHERE table_name = 'tenants'
            ORDER BY ordinal_position;
        `);

        structure.rows.forEach(col => {
            console.log(`  - ${col.column_name} (${col.data_type}) nullable: ${col.is_nullable} default: ${col.column_default || 'none'}`);
        });

        console.log('\n🔍 Verificando branches...\n');
        const branches = await client.query('SELECT * FROM branches ORDER BY id');
        console.log('📊 Branches existentes:', branches.rows);

    } catch (error) {
        console.error('❌ Error:', error.message);
    } finally {
        client.release();
        await pool.end();
    }
})();
