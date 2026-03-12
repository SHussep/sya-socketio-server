const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function runMigration() {
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║   🚀 MIGRATION: Branch Licenses (per-branch licensing)  ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // 1. Crear tabla branch_licenses
        console.log('🔄 Creando tabla branch_licenses...');
        await client.query(`
            CREATE TABLE IF NOT EXISTS branch_licenses (
                id SERIAL PRIMARY KEY,
                tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
                branch_id INTEGER REFERENCES branches(id) ON DELETE SET NULL,
                status VARCHAR(20) NOT NULL DEFAULT 'available',
                granted_by VARCHAR(50) DEFAULT 'system',
                notes TEXT,
                granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                activated_at TIMESTAMP,
                revoked_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Índices
        await client.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_branch_licenses_branch_active
            ON branch_licenses(branch_id) WHERE branch_id IS NOT NULL AND status = 'active'
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_branch_licenses_tenant_available
            ON branch_licenses(tenant_id) WHERE status = 'available'
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_branch_licenses_tenant_status
            ON branch_licenses(tenant_id, status)
        `);

        console.log('✅ Tabla e índices creados\n');

        // 2. Verificar si ya hay datos (para re-ejecución segura)
        const existingLicenses = await client.query('SELECT COUNT(*) as count FROM branch_licenses');
        if (parseInt(existingLicenses.rows[0].count) > 0) {
            console.log(`⚠️  Ya existen ${existingLicenses.rows[0].count} licencias. Saltando backfill.`);
            await client.query('COMMIT');
            await pool.end();
            return;
        }

        // 3. Backfill: crear licencias para tenants existentes
        console.log('🔄 Backfill: creando licencias para tenants existentes...\n');

        const tenantsResult = await client.query(`
            SELECT t.id, t.business_name, s.max_branches
            FROM tenants t
            JOIN subscriptions s ON t.subscription_id = s.id
            WHERE t.is_active = true
            ORDER BY t.id
        `);

        let totalActive = 0;
        let totalAvailable = 0;

        for (const tenant of tenantsResult.rows) {
            // Obtener branches activas del tenant
            const branchesResult = await client.query(
                'SELECT id, created_at FROM branches WHERE tenant_id = $1 AND is_active = true ORDER BY created_at ASC',
                [tenant.id]
            );

            // Crear licencia 'active' por cada branch existente
            for (const branch of branchesResult.rows) {
                await client.query(`
                    INSERT INTO branch_licenses (tenant_id, branch_id, status, granted_by, granted_at, activated_at, notes)
                    VALUES ($1, $2, 'active', 'system', $3, $3, 'Migración inicial - branch existente')
                `, [tenant.id, branch.id, branch.created_at]);
                totalActive++;
            }

            // Crear licencias 'available' restantes hasta max_branches
            const remaining = Math.max(0, tenant.max_branches - branchesResult.rows.length);
            for (let i = 0; i < remaining; i++) {
                await client.query(`
                    INSERT INTO branch_licenses (tenant_id, status, granted_by, notes)
                    VALUES ($1, 'available', 'system', 'Migración inicial - licencia disponible del plan')
                `, [tenant.id]);
                totalAvailable++;
            }

            console.log(`   ${tenant.business_name.padEnd(30)} | Branches: ${branchesResult.rows.length} → Active: ${branchesResult.rows.length}, Available: ${remaining}`);
        }

        await client.query('COMMIT');

        console.log('\n═══════════════════════════════════════════════════════════');
        console.log(`✅ Migración completada`);
        console.log(`   Tenants procesados: ${tenantsResult.rows.length}`);
        console.log(`   Licencias activas:    ${totalActive}`);
        console.log(`   Licencias disponibles: ${totalAvailable}`);
        console.log(`   Total licencias:       ${totalActive + totalAvailable}`);
        console.log('═══════════════════════════════════════════════════════════\n');

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ Error en migración:', error);
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
}

runMigration().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
