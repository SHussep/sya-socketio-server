/**
 * Simula una BD pre-1.3.0 para probar la migración pull-first + backfill.
 *
 * Qué hace:
 *   1. Abre la DB local existente.
 *   2. Pone GlobalId=NULL en TODAS las filas de EmployeeBranches (simula DB sin la columna poblada).
 *   3. Opcionalmente inserta una fila huérfana (sin contraparte en PG) para probar el backfill.
 *
 * Así al arrancar 1.3.0 vemos que:
 *   - Pull reconcilia los NULLs con UUIDs reales de PG.
 *   - Backfill asigna Guid temporal a la huérfana.
 *
 * USO:
 *   node scripts/simulate_pre_migration_db.js <db_path> [--add-orphan]
 */

const path = require('path');

function main() {
    const dbPath = process.argv[2];
    const addOrphan = process.argv.includes('--add-orphan');

    if (!dbPath) {
        console.error('Uso: node simulate_pre_migration_db.js <db_path> [--add-orphan]');
        process.exit(1);
    }

    let sqlite3;
    try {
        sqlite3 = require('better-sqlite3');
    } catch (e) {
        console.error('❌ Falta better-sqlite3: npm install better-sqlite3');
        process.exit(1);
    }

    const db = sqlite3(dbPath);

    console.log(`🔧 Simulando BD pre-migración en ${dbPath}\n`);

    // Backup de estado actual
    const before = db.prepare('SELECT Id, GlobalId FROM EmployeeBranches').all();
    console.log(`📋 Estado ANTES:`);
    console.log(`   Total filas: ${before.length}`);
    const withGid = before.filter(r => r.GlobalId && r.GlobalId !== '').length;
    console.log(`   Con GlobalId: ${withGid}`);
    console.log(`   Sin GlobalId: ${before.length - withGid}\n`);

    // Limpiar GlobalId en todas las filas
    const updateResult = db.prepare('UPDATE EmployeeBranches SET GlobalId = NULL').run();
    console.log(`✂️  GlobalId seteado a NULL en ${updateResult.changes} filas\n`);

    // Agregar fila huérfana opcional (emp_id, branch_id que NO existen en PG)
    if (addOrphan) {
        const lastEmp = db.prepare('SELECT MAX(Id) AS maxId FROM Employee').get();
        const lastBranch = db.prepare('SELECT MAX(Id) AS maxId FROM Branch').get();
        // Usa IDs altos para evitar FK hits en PG
        const orphanEmpId = (lastEmp?.maxId || 0) + 1000;
        const orphanBranchId = (lastBranch?.maxId || 0) + 1000;

        const session = db.prepare('SELECT TenantId FROM CurrentSession LIMIT 1').get();
        const tenantId = session?.TenantId || 1;

        const insertOrphan = db.prepare(`
            INSERT INTO EmployeeBranches (TenantId, EmployeeId, BranchId, IsActive, AssignedAt, Synced, GlobalId)
            VALUES (?, ?, ?, 1, ?, 0, NULL)
        `).run(tenantId, orphanEmpId, orphanBranchId, Date.now() * 10000);

        console.log(`🟡 Fila huérfana insertada (no existe en PG):`);
        console.log(`   Id=${insertOrphan.lastInsertRowid} emp=${orphanEmpId} branch=${orphanBranchId} GlobalId=NULL\n`);
    }

    // Estado final
    const after = db.prepare('SELECT Id, GlobalId FROM EmployeeBranches').all();
    const afterNullCount = after.filter(r => !r.GlobalId).length;
    console.log(`📋 Estado DESPUÉS:`);
    console.log(`   Total filas: ${after.length}`);
    console.log(`   Sin GlobalId: ${afterNullCount}\n`);

    db.close();

    console.log(`✅ Listo. Ahora arranca la app 1.3.0:`);
    console.log(`   - Login → Pull debería reconciliar los NULLs con UUIDs de PG.`);
    console.log(`   - Backfill defensivo asignará Guid a las que queden (huérfanas).`);
    console.log(`   - Ejecuta: node scripts/verify_employee_branches_sync.js <db_path> <tenant_id>`);
    console.log(`     para confirmar que todo quedó consistente.\n`);
}

main();
