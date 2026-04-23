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

    // Leemos Employee local para mapear Employee.Id → Employee.GlobalId
    // (porque el employee_id local NO coincide con el PG — cada lado tiene
    // su propio auto-increment; la llave compartida es Employee.GlobalId).
    const empMap = new Map();
    try {
        const empRows = sqlite.prepare('SELECT Id, GlobalId FROM Employee WHERE GlobalId IS NOT NULL').all();
        for (const e of empRows) empMap.set(e.Id, e.GlobalId);
    } catch {}

    const localByGlobalId = new Map();
    const localNullGid = [];
    for (const r of localRows) {
        if (!r.GlobalId || r.GlobalId === '') {
            localNullGid.push(r);
        } else {
            localByGlobalId.set(r.GlobalId, r);
        }
    }

    // 2. Leer PG
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    let pgRows;
    try {
        const r = await pool.query(`
            SELECT eb.id, eb.global_id, eb.tenant_id, eb.employee_id, eb.branch_id,
                   e.global_id AS employee_global_id,
                   (eb.removed_at IS NULL) AS is_active
            FROM employee_branches eb
            JOIN employees e ON e.id = eb.employee_id
            WHERE eb.tenant_id = $1
        `, [tenantId]);
        pgRows = r.rows;
    } finally {
        await pool.end();
    }

    const pgByGlobalId = new Map();
    for (const r of pgRows) {
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

    // Comparar por GlobalId de la fila EmployeeBranch (llave compartida
    // verdadera entre local y PG — independiente de los auto-increments).
    const onlyLocal = [];
    const onlyPg = [];
    const gidMatch = [];

    for (const [gid, local] of localByGlobalId) {
        const pg = pgByGlobalId.get(gid);
        if (!pg) {
            onlyLocal.push(local);
        } else {
            gidMatch.push({ local, pg });
        }
    }
    for (const [gid, pg] of pgByGlobalId) {
        if (!localByGlobalId.has(gid)) onlyPg.push(pg);
    }
    // gidMismatch ya no aplica: si los GlobalIds difieren entre emp/branch,
    // es porque son asignaciones diferentes conceptualmente. No es error.
    const gidMismatch = [];

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
