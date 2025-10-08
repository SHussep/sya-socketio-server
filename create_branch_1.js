const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function createBranch1() {
    try {
        // Intentar insertar con ID = 1
        const result = await pool.query(`
            INSERT INTO branches (id, tenant_id, branch_code, name, is_active, created_at, updated_at)
            VALUES (1, 1, 'BR001', 'Sucursal Principal', true, NOW(), NOW())
            RETURNING *
        `);

        console.log('✅ Branch ID 1 creado:', result.rows[0]);

        await pool.end();
    } catch (error) {
        console.error('❌ Error:', error.message);
        console.error('Detail:', error.detail || 'N/A');
        await pool.end();
        process.exit(1);
    }
}

createBranch1();
