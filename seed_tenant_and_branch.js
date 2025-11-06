// ========================================================================
// Script para crear Tenant y Branch iniciales en PostgreSQL
// ========================================================================
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

(async () => {
    const client = await pool.connect();
    try {
        console.log('🔄 Iniciando seed de Tenant y Branch...\n');

        await client.query('BEGIN');

        // Insertar Tenant con ID=1
        const tenantResult = await client.query(`
            INSERT INTO tenants (
                id,
                business_name,
                email,
                phone_number,
                address,
                subscription_id,
                is_active,
                subscription_status,
                subscription_plan,
                max_devices
            )
            VALUES (
                1,
                'SYA Tortillerías - Dev',
                'dev@syatortillerias.com',
                '5551234567',
                'Dirección de Prueba',
                1,
                true,
                'trial',
                'basic',
                3
            )
            ON CONFLICT (id) DO UPDATE
            SET business_name = EXCLUDED.business_name,
                updated_at = NOW()
            RETURNING *;
        `);

        console.log('✅ Tenant creado/actualizado:');
        console.log(`   ID: ${tenantResult.rows[0].id}`);
        console.log(`   Nombre: ${tenantResult.rows[0].business_name}`);
        console.log(`   Email: ${tenantResult.rows[0].email}\n`);

        // Verificar estructura de branches
        const branchStructure = await client.query(`
            SELECT column_name, data_type
            FROM information_schema.columns
            WHERE table_name = 'branches'
            ORDER BY ordinal_position;
        `);

        console.log('📋 Estructura de tabla branches:');
        branchStructure.rows.forEach(col => {
            console.log(`   - ${col.column_name} (${col.data_type})`);
        });
        console.log('');

        // Insertar Branch con ID=1
        const branchResult = await client.query(`
            INSERT INTO branches (
                id,
                tenant_id,
                branch_code,
                name,
                address,
                phone_number,
                is_active,
                timezone
            )
            VALUES (
                1,
                1,
                'SUC-001',
                'Sucursal Principal',
                'Dirección Sucursal Principal',
                '5559876543',
                true,
                'America/Chicago'
            )
            ON CONFLICT (id) DO UPDATE
            SET name = EXCLUDED.name,
                updated_at = NOW()
            RETURNING *;
        `);

        console.log('✅ Branch creado/actualizado:');
        console.log(`   ID: ${branchResult.rows[0].id}`);
        console.log(`   Nombre: ${branchResult.rows[0].name}`);
        console.log(`   Tenant ID: ${branchResult.rows[0].tenant_id}\n`);

        await client.query('COMMIT');

        console.log('✅ Seed completado exitosamente!\n');
        console.log('Ahora puedes crear empleados con:');
        console.log('  - tenantId: 1');
        console.log('  - branchId: 1\n');

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ Error ejecutando seed:', error.message);
        console.error('Stack:', error.stack);
        process.exit(1);
    } finally {
        client.release();
        await pool.end();
    }
})();
