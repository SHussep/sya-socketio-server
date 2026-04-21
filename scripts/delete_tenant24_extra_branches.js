/**
 * One-shot: elimina las branches 96, 97, 98, 99 del tenant 24 (La Lomita).
 * NUNCA toca la branch 26 ("EL TRIUNFO") ni la licencia 42.
 *
 * Uso:
 *   node scripts/delete_tenant24_extra_branches.js --dry-run   (solo simula)
 *   node scripts/delete_tenant24_extra_branches.js --execute   (aplica cambios)
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Pool } = require('pg');

const TENANT_ID = 24;
const PROTECTED_BRANCH_ID = 26;
const PROTECTED_LICENSE_ID = 42;
const TARGET_BRANCH_IDS = [96, 97, 98, 99];

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function main() {
    const mode = process.argv[2];
    if (mode !== '--dry-run' && mode !== '--execute') {
        console.log('Uso: node scripts/delete_tenant24_extra_branches.js --dry-run | --execute');
        process.exit(1);
    }
    const execute = mode === '--execute';

    const client = await pool.connect();
    try {
        console.log(`\n=== Modo: ${execute ? 'EXECUTE (aplicará cambios)' : 'DRY-RUN (sin cambios)'} ===\n`);

        // 1) Snapshot pre: branch protegida 26
        const before26 = await client.query(
            `SELECT id, tenant_id, name, branch_code, is_active,
                (SELECT COUNT(*) FROM ventas WHERE branch_id = $1) AS ventas,
                (SELECT COUNT(*) FROM shifts WHERE branch_id = $1) AS shifts
             FROM branches WHERE id = $1`,
            [PROTECTED_BRANCH_ID]
        );
        if (before26.rows.length === 0) {
            throw new Error(`Branch protegida ${PROTECTED_BRANCH_ID} no encontrada — ABORT`);
        }
        if (before26.rows[0].tenant_id !== TENANT_ID) {
            throw new Error(`Branch ${PROTECTED_BRANCH_ID} no pertenece a tenant ${TENANT_ID} — ABORT`);
        }
        console.log('🛡️  Branch protegida ANTES:', before26.rows[0]);

        // 2) Validar que cada target pertenece a tenant 24 y no es la protegida
        const targets = await client.query(
            `SELECT id, tenant_id, name, branch_code FROM branches WHERE id = ANY($1::int[])`,
            [TARGET_BRANCH_IDS]
        );
        if (targets.rows.length !== TARGET_BRANCH_IDS.length) {
            const found = targets.rows.map(r => r.id);
            const missing = TARGET_BRANCH_IDS.filter(id => !found.includes(id));
            throw new Error(`Branches no encontradas: ${missing.join(',')} — ABORT`);
        }
        for (const b of targets.rows) {
            if (b.id === PROTECTED_BRANCH_ID) {
                throw new Error(`Target incluye branch protegida ${PROTECTED_BRANCH_ID} — ABORT`);
            }
            if (b.tenant_id !== TENANT_ID) {
                throw new Error(`Branch ${b.id} no pertenece a tenant ${TENANT_ID} — ABORT`);
            }
        }
        console.log(`\n🎯 Targets validadas (${targets.rows.length}):`);
        targets.rows.forEach(b => console.log(`   - ${b.id} ${b.branch_code} "${b.name}"`));

        // 3) Re-validar 0 datos transaccionales en cada target
        const dataCheck = await client.query(`
            SELECT b.id,
              (SELECT COUNT(*) FROM ventas v WHERE v.branch_id = b.id) AS ventas,
              (SELECT COUNT(*) FROM shifts s WHERE s.branch_id = b.id) AS shifts,
              (SELECT COUNT(*) FROM cash_cuts c WHERE c.branch_id = b.id) AS cash_cuts,
              (SELECT COUNT(*) FROM purchases p WHERE p.branch_id = b.id) AS purchases,
              (SELECT COUNT(*) FROM kardex_entries k WHERE k.branch_id = b.id) AS kardex,
              (SELECT COUNT(*) FROM notas_credito n WHERE n.branch_id = b.id) AS notas_credito,
              (SELECT COUNT(*) FROM employee_branches eb WHERE eb.branch_id = b.id) AS empleados,
              (SELECT COUNT(*) FROM branch_devices bd WHERE bd.branch_id = b.id) AS devices
            FROM branches b
            WHERE b.id = ANY($1::int[])
            ORDER BY b.id
        `, [TARGET_BRANCH_IDS]);

        console.log('\n📊 Datos en targets:');
        let blocked = false;
        for (const r of dataCheck.rows) {
            console.log(`   branch ${r.id} → ventas=${r.ventas} shifts=${r.shifts} cash_cuts=${r.cash_cuts} purchases=${r.purchases} kardex=${r.kardex} notas=${r.notas_credito} empleados=${r.empleados} devices=${r.devices}`);
            if (parseInt(r.ventas) > 0 || parseInt(r.shifts) > 0 || parseInt(r.cash_cuts) > 0 || parseInt(r.purchases) > 0) {
                console.error(`   ❌ branch ${r.id} tiene datos transaccionales — ABORT`);
                blocked = true;
            }
        }
        if (blocked) throw new Error('Una o más branches tienen datos transaccionales — ABORT');

        // 4) Snapshot de licencias
        const licsBefore = await client.query(`
            SELECT id, branch_id, status FROM branch_licenses
            WHERE tenant_id = $1 ORDER BY id
        `, [TENANT_ID]);
        console.log(`\n📜 Licencias del tenant ${TENANT_ID} ANTES:`);
        licsBefore.rows.forEach(l => console.log(`   - lic ${l.id} branch=${l.branch_id} status=${l.status}`));

        const licensesToRevoke = licsBefore.rows
            .filter(l => TARGET_BRANCH_IDS.includes(l.branch_id) && l.status === 'active')
            .map(l => l.id);
        console.log(`\n   → Se revocarán las licencias: [${licensesToRevoke.join(', ')}]`);
        if (licensesToRevoke.includes(PROTECTED_LICENSE_ID)) {
            throw new Error(`Plan de revocar incluye licencia protegida ${PROTECTED_LICENSE_ID} — ABORT`);
        }

        if (!execute) {
            console.log('\n✅ DRY-RUN OK. Re-ejecuta con --execute para aplicar.');
            return;
        }

        // 5) Transacción
        await client.query('BEGIN');
        console.log('\n🔧 BEGIN transaction');

        // 5a) Limpiar tablas con NO ACTION (las que CASCADE no maneja)
        const tablesNoAction = [
            'data_resets',
            'employee_debts',
            'inventory_transfers',          // to_branch_id / from_branch_id manejados aparte
            'kardex_entries',
            'notas_credito',
            'preparation_mode_logs',
            'production_alerts',
            'production_entries',
            'production_yield_configs',
            'producto_branches',
            'sync_error_reports',
            'sync_events'
        ];
        for (const t of tablesNoAction) {
            if (t === 'inventory_transfers') continue;
            const r = await client.query(
                `DELETE FROM ${t} WHERE branch_id = ANY($1::int[])`,
                [TARGET_BRANCH_IDS]
            );
            if (r.rowCount > 0) console.log(`   - ${t}: ${r.rowCount} filas borradas`);
        }
        // inventory_transfers tiene to_branch_id y from_branch_id
        const itr = await client.query(
            `DELETE FROM inventory_transfers
             WHERE from_branch_id = ANY($1::int[]) OR to_branch_id = ANY($1::int[])`,
            [TARGET_BRANCH_IDS]
        );
        if (itr.rowCount > 0) console.log(`   - inventory_transfers: ${itr.rowCount} filas borradas`);

        // employees.main_branch_id es NO ACTION → SET NULL si apunta a target
        const empNull = await client.query(
            `UPDATE employees SET main_branch_id = NULL
             WHERE main_branch_id = ANY($1::int[])`,
            [TARGET_BRANCH_IDS]
        );
        if (empNull.rowCount > 0) console.log(`   - employees.main_branch_id puesto NULL: ${empNull.rowCount}`);

        // 5b) Revocar licencias activas asociadas (status='revoked', branch_id=NULL)
        if (licensesToRevoke.length > 0) {
            const lr = await client.query(`
                UPDATE branch_licenses
                SET status = 'revoked', branch_id = NULL, revoked_at = NOW(), updated_at = NOW()
                WHERE id = ANY($1::int[]) AND tenant_id = $2 AND status = 'active'
                RETURNING id
            `, [licensesToRevoke, TENANT_ID]);
            console.log(`   - branch_licenses revocadas: [${lr.rows.map(r => r.id).join(',')}]`);
        }

        // 5c) Borrar branches (CASCADE limpia el resto)
        const del = await client.query(
            `DELETE FROM branches WHERE id = ANY($1::int[]) AND tenant_id = $2 AND id <> $3
             RETURNING id, name`,
            [TARGET_BRANCH_IDS, TENANT_ID, PROTECTED_BRANCH_ID]
        );
        console.log(`   - branches borradas: ${del.rowCount}`);
        del.rows.forEach(r => console.log(`     · ${r.id} "${r.name}"`));

        if (del.rowCount !== TARGET_BRANCH_IDS.length) {
            throw new Error(`Esperaba borrar ${TARGET_BRANCH_IDS.length} branches, borré ${del.rowCount} — ROLLBACK`);
        }

        // 5d) Verificar que branch 26 sigue intacta dentro de la misma tx
        const after26 = await client.query(
            `SELECT id, tenant_id, name, branch_code, is_active,
                (SELECT COUNT(*) FROM ventas WHERE branch_id = $1) AS ventas,
                (SELECT COUNT(*) FROM shifts WHERE branch_id = $1) AS shifts
             FROM branches WHERE id = $1`,
            [PROTECTED_BRANCH_ID]
        );
        if (after26.rows.length === 0) {
            throw new Error(`Branch protegida ${PROTECTED_BRANCH_ID} desapareció — ROLLBACK`);
        }
        const a = after26.rows[0];
        const b = before26.rows[0];
        if (a.ventas !== b.ventas || a.shifts !== b.shifts || a.is_active !== b.is_active || a.name !== b.name) {
            throw new Error(`Branch protegida ${PROTECTED_BRANCH_ID} cambió: antes=${JSON.stringify(b)} ahora=${JSON.stringify(a)} — ROLLBACK`);
        }

        // 5e) Verificar licencia 42 sigue activa con branch 26
        const lic42 = await client.query(
            `SELECT id, branch_id, status FROM branch_licenses WHERE id = $1`,
            [PROTECTED_LICENSE_ID]
        );
        if (lic42.rows.length === 0 || lic42.rows[0].status !== 'active' || lic42.rows[0].branch_id !== PROTECTED_BRANCH_ID) {
            throw new Error(`Licencia protegida ${PROTECTED_LICENSE_ID} alterada: ${JSON.stringify(lic42.rows[0])} — ROLLBACK`);
        }

        await client.query('COMMIT');
        console.log('\n✅ COMMIT');

        // 6) Reporte final
        const after = await client.query(`
            SELECT b.id, b.name, b.branch_code FROM branches b WHERE b.tenant_id = $1 ORDER BY b.id
        `, [TENANT_ID]);
        const licsAfter = await client.query(`
            SELECT id, branch_id, status FROM branch_licenses WHERE tenant_id = $1 ORDER BY id
        `, [TENANT_ID]);

        console.log(`\n📋 Tenant ${TENANT_ID} DESPUÉS:`);
        console.log('   Branches:');
        after.rows.forEach(r => console.log(`     - ${r.id} ${r.branch_code} "${r.name}"`));
        console.log('   Licencias:');
        licsAfter.rows.forEach(l => console.log(`     - lic ${l.id} branch=${l.branch_id} status=${l.status}`));
        const active = licsAfter.rows.filter(l => l.status === 'active').length;
        const available = licsAfter.rows.filter(l => l.status === 'available').length;
        console.log(`   Resumen: ${active} activas, ${available} disponibles`);
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('\n❌ ERROR:', err.message);
        process.exitCode = 1;
    } finally {
        client.release();
        await pool.end();
    }
}

main();
