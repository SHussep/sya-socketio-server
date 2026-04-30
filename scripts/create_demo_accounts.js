#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// SCRIPT: create_demo_accounts
// Crea (o actualiza) 2 cuentas demo para Apple App Review:
//   1. demo-active@syademo.com  → licencia ACTIVA (POS visible)
//   2. demo-expired@syademo.com → licencia VENCIDA (POS oculto)
//
// Ambas tienen password: Demo2026!
//
// Uso:
//   node scripts/create_demo_accounts.js
//
// Idempotente: si los tenants/empleados ya existen, los actualiza
// para asegurar el estado deseado (trial_ends_at, password_hash,
// branch_license expiry).
// ═══════════════════════════════════════════════════════════════

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { pool } = require('../database');

const PASSWORD = 'Demo2026!';

const ACTIVE = {
    tenantCode: 'DEMO_ACTIVE',
    businessName: 'SYA Demo Activa',
    email: 'demo-active@syademo.com',
    branchCode: 'DEMO_A_1',
    branchName: 'Sucursal Demo Activa',
    trialEndsAt: '2027-12-31 23:59:59+00',
    licenseExpiresAt: '2027-12-31 23:59:59+00'
};

const EXPIRED = {
    tenantCode: 'DEMO_EXPIRED',
    businessName: 'SYA Demo Vencida',
    email: 'demo-expired@syademo.com',
    branchCode: 'DEMO_E_1',
    branchName: 'Sucursal Demo Vencida',
    trialEndsAt: '2025-01-01 00:00:00+00',
    licenseExpiresAt: '2025-01-01 00:00:00+00'
};

async function ensureSubscription(client) {
    const r = await client.query(
        `SELECT id FROM subscriptions WHERE name = 'basic' LIMIT 1`
    );
    if (r.rowCount > 0) return r.rows[0].id;

    const ins = await client.query(
        `INSERT INTO subscriptions (name, max_branches, max_devices, max_employees, is_active)
         VALUES ('basic', 1, 1, 5, true)
         RETURNING id`
    );
    return ins.rows[0].id;
}

async function ensureRole(client) {
    const r = await client.query(
        `SELECT id FROM roles WHERE name = 'Administrador' LIMIT 1`
    );
    if (r.rowCount > 0) return r.rows[0].id;

    const ins = await client.query(
        `INSERT INTO roles (id, name, description)
         VALUES (1, 'Administrador', 'Acceso total al sistema')
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`
    );
    return ins.rows[0].id;
}

async function upsertTenant(client, spec, subscriptionId) {
    const r = await client.query(
        `SELECT id FROM tenants WHERE tenant_code = $1`,
        [spec.tenantCode]
    );

    if (r.rowCount > 0) {
        const id = r.rows[0].id;
        await client.query(
            `UPDATE tenants
             SET business_name = $1,
                 email = $2,
                 subscription_id = $3,
                 trial_ends_at = $4,
                 is_active = true,
                 updated_at = NOW()
             WHERE id = $5`,
            [spec.businessName, spec.email, subscriptionId, spec.trialEndsAt, id]
        );
        return id;
    }

    const ins = await client.query(
        `INSERT INTO tenants
            (tenant_code, business_name, email, subscription_id, subscription_status, trial_ends_at, is_active)
         VALUES ($1, $2, $3, $4, 'trial', $5, true)
         RETURNING id`,
        [spec.tenantCode, spec.businessName, spec.email, subscriptionId, spec.trialEndsAt]
    );
    return ins.rows[0].id;
}

async function upsertBranch(client, tenantId, spec) {
    const r = await client.query(
        `SELECT id FROM branches WHERE tenant_id = $1 AND branch_code = $2`,
        [tenantId, spec.branchCode]
    );

    if (r.rowCount > 0) {
        const id = r.rows[0].id;
        await client.query(
            `UPDATE branches SET name = $1, is_active = true, updated_at = NOW() WHERE id = $2`,
            [spec.branchName, id]
        );
        return id;
    }

    const ins = await client.query(
        `INSERT INTO branches (tenant_id, branch_code, name, is_active)
         VALUES ($1, $2, $3, true)
         RETURNING id`,
        [tenantId, spec.branchCode, spec.branchName]
    );
    return ins.rows[0].id;
}

async function upsertBranchLicense(client, tenantId, branchId, expiresAt) {
    await client.query(
        `UPDATE branch_licenses
            SET status = 'revoked', revoked_at = NOW(), updated_at = NOW()
          WHERE branch_id = $1 AND status = 'active'`,
        [branchId]
    );

    await client.query(
        `INSERT INTO branch_licenses
            (tenant_id, branch_id, status, granted_by, expires_at, duration_days, granted_at, activated_at, assigned_at)
         VALUES ($1, $2, 'active', 'system', $3, 365, NOW(), NOW(), NOW())`,
        [tenantId, branchId, expiresAt]
    );
}

async function upsertEmployee(client, tenantId, branchId, spec, roleId, passwordHash) {
    const r = await client.query(
        `SELECT id, global_id FROM employees WHERE tenant_id = $1 AND email = $2`,
        [tenantId, spec.email]
    );

    let employeeId;
    if (r.rowCount > 0) {
        employeeId = r.rows[0].id;
        await client.query(
            `UPDATE employees
             SET first_name = 'Demo',
                 last_name = 'Apple',
                 username = $1,
                 password_hash = $2,
                 role_id = $3,
                 is_active = true,
                 is_owner = true,
                 mobile_access_type = 'admin',
                 can_use_mobile_app = true,
                 main_branch_id = $4,
                 email_verified = true,
                 updated_at = NOW()
             WHERE id = $5`,
            [spec.email, passwordHash, roleId, branchId, employeeId]
        );
    } else {
        const ins = await client.query(
            `INSERT INTO employees
                (tenant_id, username, first_name, last_name, email, password_hash, role_id,
                 is_active, is_owner, mobile_access_type, can_use_mobile_app, main_branch_id,
                 email_verified, global_id)
             VALUES ($1, $2, 'Demo', 'Apple', $3, $4, $5, true, true, 'admin', true, $6, true, $7)
             RETURNING id`,
            [tenantId, spec.email, spec.email, passwordHash, roleId, branchId, crypto.randomUUID()]
        );
        employeeId = ins.rows[0].id;
    }

    const eb = await client.query(
        `SELECT id FROM employee_branches WHERE tenant_id = $1 AND employee_id = $2 AND branch_id = $3`,
        [tenantId, employeeId, branchId]
    );
    if (eb.rowCount === 0) {
        await client.query(
            `INSERT INTO employee_branches (tenant_id, employee_id, branch_id)
             VALUES ($1, $2, $3)`,
            [tenantId, employeeId, branchId]
        );
    }

    return employeeId;
}

async function provisionAccount(client, spec, subscriptionId, roleId, passwordHash) {
    const tenantId = await upsertTenant(client, spec, subscriptionId);
    const branchId = await upsertBranch(client, tenantId, spec);
    await upsertBranchLicense(client, tenantId, branchId, spec.licenseExpiresAt);
    const employeeId = await upsertEmployee(client, tenantId, branchId, spec, roleId, passwordHash);

    return { tenantId, branchId, employeeId, email: spec.email };
}

async function main() {
    const passwordHash = await bcrypt.hash(PASSWORD, 10);

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const subscriptionId = await ensureSubscription(client);
        const roleId = await ensureRole(client);

        const active = await provisionAccount(client, ACTIVE, subscriptionId, roleId, passwordHash);
        const expired = await provisionAccount(client, EXPIRED, subscriptionId, roleId, passwordHash);

        await client.query('COMMIT');

        console.log('═══════════════════════════════════════════════════════');
        console.log('✅ Cuentas demo creadas/actualizadas');
        console.log('═══════════════════════════════════════════════════════');
        console.log('');
        console.log('CUENTA 1 — Licencia ACTIVA (POS visible)');
        console.log(`  Email:    ${active.email}`);
        console.log(`  Password: ${PASSWORD}`);
        console.log(`  Tenant ID: ${active.tenantId}, Branch ID: ${active.branchId}, Employee ID: ${active.employeeId}`);
        console.log('');
        console.log('CUENTA 2 — Licencia VENCIDA (POS oculto, app complementaria)');
        console.log(`  Email:    ${expired.email}`);
        console.log(`  Password: ${PASSWORD}`);
        console.log(`  Tenant ID: ${expired.tenantId}, Branch ID: ${expired.branchId}, Employee ID: ${expired.employeeId}`);
        console.log('');
        console.log('═══════════════════════════════════════════════════════');
        console.log('Usar estas credenciales en App Store Connect →');
        console.log('  App Review Information → Sign-in required');
        console.log('═══════════════════════════════════════════════════════');
        process.exit(0);
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('❌ Error creando cuentas demo:', err.message);
        console.error(err.stack);
        process.exit(1);
    } finally {
        client.release();
        try { await pool.end(); } catch (e) { /* ignore */ }
    }
}

main();
