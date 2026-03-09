// ═══════════════════════════════════════════════════════════════
// Script de diagnóstico para verificar estado de la base de datos
// ═══════════════════════════════════════════════════════════════

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

async function diagnose() {
    try {
        console.log('\n🔍 DIAGNÓSTICO DE BASE DE DATOS\n');
        console.log('='.repeat(80));

        // 1. TENANTS
        const tenants = await pool.query(`
            SELECT
                id,
                tenant_code,
                business_name,
                email,
                subscription_id,
                created_at
            FROM tenants
            ORDER BY id DESC
        `);

        console.log('\n📊 TENANTS:');
        console.log('-'.repeat(80));
        tenants.rows.forEach(t => {
            console.log(`ID: ${t.id} | Code: ${t.tenant_code} | Business: ${t.business_name}`);
            console.log(`   Email: ${t.email}`);
            console.log(`   Subscription ID: ${t.subscription_id || '❌ NULL'}`);
            console.log(`   Created: ${t.created_at}`);
            console.log();
        });

        // 2. BRANCHES
        const branches = await pool.query(`
            SELECT
                id,
                tenant_id,
                branch_code,
                name,
                created_at
            FROM branches
            ORDER BY tenant_id, id
        `);

        console.log('\n📊 BRANCHES:');
        console.log('-'.repeat(80));
        branches.rows.forEach(b => {
            console.log(`ID: ${b.id} | Tenant: ${b.tenant_id} | Code: ${b.branch_code}`);
            console.log(`   Name: ${b.name}`);
            console.log(`   Created: ${b.created_at}`);
            console.log();
        });

        // 3. EMPLOYEES
        const employees = await pool.query(`
            SELECT
                id,
                tenant_id,
                email,
                full_name,
                role,
                main_branch_id
            FROM employees
            ORDER BY tenant_id, id
        `);

        console.log('\n📊 EMPLOYEES:');
        console.log('-'.repeat(80));
        employees.rows.forEach(e => {
            console.log(`ID: ${e.id} | Tenant: ${e.tenant_id} | Email: ${e.email}`);
            console.log(`   Name: ${e.full_name} | Role: ${e.role}`);
            console.log(`   Main Branch: ${e.main_branch_id || '❌ NULL'}`);
            console.log();
        });

        // 4. BACKUPS
        const backups = await pool.query(`
            SELECT
                id,
                tenant_id,
                branch_id,
                backup_filename,
                file_size_bytes,
                backup_path,
                created_at
            FROM backup_metadata
            ORDER BY tenant_id, branch_id, created_at DESC
        `);

        console.log('\n📊 BACKUPS:');
        console.log('-'.repeat(80));
        if (backups.rows.length === 0) {
            console.log('❌ No hay backups en la base de datos');
        } else {
            backups.rows.forEach(b => {
                console.log(`ID: ${b.id} | Tenant: ${b.tenant_id} | Branch: ${b.branch_id}`);
                console.log(`   File: ${b.backup_filename}`);
                console.log(`   Size: ${(b.file_size_bytes / 1024).toFixed(2)} KB`);
                console.log(`   Path: ${b.backup_path}`);
                console.log(`   Created: ${b.created_at}`);
                console.log();
            });
        }

        // 5. PROBLEMAS DETECTADOS
        console.log('\n⚠️  PROBLEMAS DETECTADOS:');
        console.log('-'.repeat(80));

        const tenantsWithoutSub = tenants.rows.filter(t => !t.subscription_id);
        if (tenantsWithoutSub.length > 0) {
            console.log(`❌ ${tenantsWithoutSub.length} tenant(s) sin subscription_id:`);
            tenantsWithoutSub.forEach(t => {
                console.log(`   - Tenant ${t.id}: ${t.business_name} (${t.email})`);
            });
            console.log();
        }

        const employeesWithoutBranch = employees.rows.filter(e => !e.main_branch_id);
        if (employeesWithoutBranch.length > 0) {
            console.log(`❌ ${employeesWithoutBranch.length} empleado(s) sin main_branch_id:`);
            employeesWithoutBranch.forEach(e => {
                console.log(`   - Employee ${e.id}: ${e.full_name} (${e.email})`);
            });
            console.log();
        }

        if (tenantsWithoutSub.length === 0 && employeesWithoutBranch.length === 0 && backups.rows.length > 0) {
            console.log('✅ No se detectaron problemas');
        }

        console.log('\n' + '='.repeat(80));
        console.log('✅ Diagnóstico completado\n');

        await pool.end();
        process.exit(0);

    } catch (error) {
        console.error('\n❌ Error en diagnóstico:', error);
        await pool.end();
        process.exit(1);
    }
}

diagnose();
