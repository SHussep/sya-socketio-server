const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function fixBranches() {
    try {
        // Ver qué branches existen
        console.log('📋 Branches existentes:');
        const existing = await pool.query('SELECT * FROM branches ORDER BY id');
        existing.rows.forEach(b => {
            console.log(`  ID ${b.id}: ${b.branch_name} (${b.branch_code}) - Tenant: ${b.tenant_id}`);
        });

        // Verificar si existe branch_id = 1
        const branch1 = await pool.query('SELECT * FROM branches WHERE id = 1');

        if (branch1.rows.length === 0) {
            console.log('\n🔧 Creando Branch ID 1...');

            // Insertar branch con ID 1
            const result = await pool.query(`
                INSERT INTO branches (id, branch_name, branch_code, tenant_id, is_active, created_at, updated_at)
                VALUES (1, 'Sucursal Principal', 'BR001', 1, true, NOW(), NOW())
                RETURNING *
            `);

            console.log('✅ Branch creado:', result.rows[0]);
        } else {
            console.log('\n✅ Branch ID 1 ya existe');
        }

        await pool.end();
    } catch (error) {
        console.error('❌ Error:', error.message);
        console.error('Detail:', error.detail || 'N/A');
        await pool.end();
        process.exit(1);
    }
}

fixBranches();
