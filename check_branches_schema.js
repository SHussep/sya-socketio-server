const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function checkBranches() {
    try {
        // Ver estructura
        console.log('📋 Columnas de branches:');
        const cols = await pool.query(`
            SELECT column_name, data_type
            FROM information_schema.columns
            WHERE table_name = 'branches'
            ORDER BY ordinal_position
        `);
        cols.rows.forEach(c => console.log(`  - ${c.column_name}: ${c.data_type}`));

        // Ver datos existentes
        console.log('\n📊 Branches existentes:');
        const data = await pool.query('SELECT * FROM branches');
        data.rows.forEach(b => {
            console.log(`  ID ${b.id}: Code=${b.code}, Name=${b.name}, Tenant=${b.tenant_id}`);
        });

        await pool.end();
    } catch (error) {
        console.error('❌ Error:', error.message);
        await pool.end();
    }
}

checkBranches();
