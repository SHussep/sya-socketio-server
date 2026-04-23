/**
 * Verifica el estado de sincronización de EmployeeBranches entre SQLite local y PG.
 *
 * USO:
 *   node scripts/verify_employee_branches_sync.js <ruta_a_SYATortillerias.db3> <tenant_id>
 *
 * EJEMPLO:
 *   node scripts/verify_employee_branches_sync.js \
 *     "C:/Users/saul_/AppData/Local/Packages/40249SaulCorona.SYATortillerias_3q9sdmdf41emt/LocalState/SYATortillerias.db3" \
 *     18
 *
 * REPORTA:
 *   - Filas locales con GlobalId NULL (debería ser 0 tras backfill).
 *   - Filas en PG no presentes en local (pendientes de pull).
 *   - Filas locales no presentes en PG (pendientes de push u huérfanas).
 *   - Filas con mismo (emp, branch) pero GlobalId distinto (desincronizado).
 *   - Filas con mismo GlobalId en ambos lados (OK).
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const path = require('path');
const { Pool } = require('pg');

async function main() {
    const dbPath = process.argv[2];
    const tenantId = parseInt(process.argv[3], 10);

    if (!dbPath || !tenantId) {
        console.error('Uso: node verify_employee_branches_sync.js <db_path> <tenant_id>');
        process.exit(1);
    }

    let sqlite3;
    try {
        sqlite3 = require('better-sqlite3');
    } catch (e) {
        console.error('❌ Falta dependencia: npm install better-sqlite3 (instálala en el repo del server)');
        process.exit(1);
    }

    console.log(`\n🔍 Verificando EmployeeBranches sync`);
    console.log(`   DB local: ${dbPath}`);
    console.log(`   Tenant ID: ${tenantId}\n`);

    // 1. Leer SQLite local
    const sqlite = sqlite3(dbPath, { readonly: true });
    const localRows = sqlite.prepare(`
        SELECT Id, GlobalId, TenantId, EmployeeId, BranchId, IsActive, Synced, RemoteId
        FROM EmployeeBranches
        WHERE TenantId = ?
    `).all(tenantId);
    sqlite.close();

    const localMap = new Map(); // key: "emp_id:branch_id" → row
    const localByGlobalId = new Map();
    const localNullGid = [];
    for (const r of localRows) {
        if (!r.GlobalId || r.GlobalId === '') {
            localNullGid.push(r);
        } else {
            localByGlobalId.set(r.GlobalId, r);
        }
        localMap.set(`${r.EmployeeId}:${r.BranchId}`, r);
    }

    // 2. Leer PG
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    let pgRows;
    try {
        const r = await pool.query(`
            SELECT id, global_id, tenant_id, employee_id, branch_id,
                   (removed_at IS NULL) AS is_active
            FROM employee_branches
            WHERE tenant_id = $1
        `, [tenantId]);
        pgRows = r.rows;
    } finally {
        await pool.end();
    }

    const pgMap = new Map();
    const pgByGlobalId = new Map();
    for (const r of pgRows) {
        pgMap.set(`${r.employee_id}:${r.branch_id}`, r);
        if (r.global_id) pgByGlobalId.set(r.global_id, r);
    }

    // 3. Analizar
    console.log(`📊 Conteos:`);
    console.log(`   Local: ${localRows.length} filas (${localNullGid.length} sin GlobalId)`);
    console.log(`   PG:    ${pgRows.length} filas\n`);

    if (localNullGid.length > 0) {
        console.log(`❌ FILAS LOCALES SIN GlobalId (${localNullGid.length}):`);
        for (const r of localNullGid) {
            console.log(`   - Id=${r.Id} emp=${r.EmployeeId} branch=${r.BranchId} synced=${r.Synced}`);
        }
        console.log();
    }

    // Mismatch por llave natural (emp, branch)
    const onlyLocal = [];
    const onlyPg = [];
    const gidMismatch = [];
    const gidMatch = [];

    for (const [key, local] of localMap) {
        if (!local.GlobalId) continue;
        const pg = pgMap.get(key);
        if (!pg) {
            onlyLocal.push(local);
            continue;
        }
        if (local.GlobalId === pg.global_id) {
            gidMatch.push({ local, pg });
        } else {
            gidMismatch.push({ local, pg });
        }
    }
    for (const [key, pg] of pgMap) {
        if (!localMap.has(key)) onlyPg.push(pg);
    }

    if (onlyPg.length > 0) {
        console.log(`⚠️  EN PG PERO NO EN LOCAL (${onlyPg.length}) — pendientes de pull:`);
        for (const r of onlyPg) {
            console.log(`   - id=${r.id} emp=${r.employee_id} branch=${r.branch_id} global_id=${r.global_id}`);
        }
        console.log();
    }

    if (onlyLocal.length > 0) {
        console.log(`⚠️  EN LOCAL PERO NO EN PG (${onlyLocal.length}) — pendientes de push u huérfanas:`);
        for (const r of onlyLocal) {
            console.log(`   - Id=${r.Id} emp=${r.EmployeeId} branch=${r.BranchId} GlobalId=${r.GlobalId} Synced=${r.Synced}`);
        }
        console.log();
    }

    if (gidMismatch.length > 0) {
        console.log(`🔴 MISMO (emp,branch) PERO GlobalId DISTINTO (${gidMismatch.length}) — desincronizado:`);
        for (const { local, pg } of gidMismatch) {
            console.log(`   - emp=${local.EmployeeId} branch=${local.BranchId}`);
            console.log(`       local: ${local.GlobalId}`);
            console.log(`       PG:    ${pg.global_id}`);
        }
        console.log();
    }

    if (gidMatch.length > 0) {
        console.log(`✅ GlobalId IDÉNTICO en local y PG (${gidMatch.length}):`);
        for (const { local } of gidMatch.slice(0, 10)) {
            console.log(`   - emp=${local.EmployeeId} branch=${local.BranchId} GlobalId=${local.GlobalId}`);
        }
        if (gidMatch.length > 10) console.log(`   ... y ${gidMatch.length - 10} más`);
        console.log();
    }

    console.log(`═══════════════════════════════════════`);
    if (localNullGid.length === 0 && gidMismatch.length === 0) {
        console.log(`✅ VERIFICACIÓN OK: sin nulos, sin mismatches.`);
    } else {
        console.log(`❌ VERIFICACIÓN FALLIDA: revisar mensajes arriba.`);
    }
    console.log(`═══════════════════════════════════════\n`);
}

main().catch(err => {
    console.error('❌ Error:', err.message);
    process.exit(1);
});
