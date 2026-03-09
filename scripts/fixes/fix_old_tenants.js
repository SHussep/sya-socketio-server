// ═══════════════════════════════════════════════════════════════
// Script para arreglar tenants antiguos sin subscription_id
// ═══════════════════════════════════════════════════════════════

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

async function fixOldTenants() {
    try {
        console.log('\n🔧 ARREGLANDO TENANTS ANTIGUOS SIN SUBSCRIPTION_ID\n');
        console.log('='.repeat(80));

        // 1. Obtener el ID del plan Basic
        const subscriptionResult = await pool.query(
            "SELECT id FROM subscriptions WHERE name = 'Basic' LIMIT 1"
        );

        if (subscriptionResult.rows.length === 0) {
            console.error('❌ ERROR: No se encontró el plan Basic en la base de datos');
            console.error('   Debes crear primero las subscripciones');
            process.exit(1);
        }

        const basicSubscriptionId = subscriptionResult.rows[0].id;
        console.log(`✅ Plan Basic encontrado con ID: ${basicSubscriptionId}\n`);

        // 2. Obtener tenants sin subscription_id
        const tenantsResult = await pool.query(
            'SELECT id, tenant_code, business_name, email FROM tenants WHERE subscription_id IS NULL'
        );

        const oldTenants = tenantsResult.rows;

        if (oldTenants.length === 0) {
            console.log('✅ No hay tenants para arreglar. Todos tienen subscription_id asignado.\n');
            await pool.end();
            process.exit(0);
        }

        console.log(`📋 Tenants sin subscription_id: ${oldTenants.length}\n`);

        // 3. Actualizar cada tenant
        for (const tenant of oldTenants) {
            console.log(`⚙️  Actualizando Tenant ${tenant.id}: ${tenant.business_name} (${tenant.email})`);

            await pool.query(
                'UPDATE tenants SET subscription_id = $1 WHERE id = $2',
                [basicSubscriptionId, tenant.id]
            );

            console.log(`   ✅ Subscription_id asignado: ${basicSubscriptionId}`);
        }

        console.log('\n' + '='.repeat(80));
        console.log(`✅ COMPLETADO: ${oldTenants.length} tenant(s) actualizados\n`);

        // 4. Verificar
        const verifyResult = await pool.query(
            'SELECT COUNT(*) as count FROM tenants WHERE subscription_id IS NULL'
        );

        const remaining = parseInt(verifyResult.rows[0].count);

        if (remaining === 0) {
            console.log('✅ Verificación: Todos los tenants tienen subscription_id\n');
        } else {
            console.log(`⚠️  Advertencia: Aún quedan ${remaining} tenant(s) sin subscription_id\n`);
        }

        await pool.end();
        process.exit(0);

    } catch (error) {
        console.error('\n❌ Error:', error);
        await pool.end();
        process.exit(1);
    }
}

fixOldTenants();
