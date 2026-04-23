/**
 * Inspección rápida de EmployeeBranches en la BD local SQLite.
 *
 * USO:
 *   node scripts/inspect_local_employee_branches.js <db_path>
 *
 * Muestra:
 *   - Todas las filas con GlobalId, Employee name, BranchId, IsActive, Synced, RemoteId.
 *   - Totales y resumen.
 */

const db = require('better-sqlite3')(process.argv[2], { readonly: true });

const session = db.prepare('SELECT TenantId, TenantCode, BusinessName, BranchId, BranchName FROM CurrentSession LIMIT 1').get();
console.log(`\n📋 Sesión actual: TenantId=${session?.TenantId} TenantCode=${session?.TenantCode}`);
console.log(`                 Branch activa: ${session?.BranchName} (Id=${session?.BranchId})\n`);

const rows = db.prepare(`
  SELECT eb.Id, eb.GlobalId, eb.EmployeeId, e.FullName AS Empleado,
         eb.BranchId, eb.IsActive, eb.Synced, eb.RemoteId
  FROM EmployeeBranches eb
  LEFT JOIN Employee e ON e.Id = eb.EmployeeId
  ORDER BY eb.EmployeeId, eb.BranchId
`).all();

if (rows.length === 0) {
    console.log('⚠️  No hay filas en EmployeeBranches.\n');
} else {
    console.log(`📊 EmployeeBranches (${rows.length} filas):\n`);
    console.table(rows.map(r => ({
        Id: r.Id,
        Empleado: r.Empleado ?? `(emp_id=${r.EmployeeId})`,
        BranchId: r.BranchId,
        Active: !!r.IsActive,
        Synced: !!r.Synced,
        RemoteId: r.RemoteId ?? '-',
        GlobalId: r.GlobalId ? r.GlobalId.substring(0, 8) + '...' : '❌ NULL'
    })));
}

const stats = {
    total: rows.length,
    conGlobalId: rows.filter(r => r.GlobalId && r.GlobalId !== '').length,
    sinGlobalId: rows.filter(r => !r.GlobalId || r.GlobalId === '').length,
    synced: rows.filter(r => r.Synced === 1).length,
    noSynced: rows.filter(r => r.Synced === 0 || r.Synced === null).length
};

console.log(`\n📈 Resumen:`);
console.log(`   Total:             ${stats.total}`);
console.log(`   Con GlobalId:      ${stats.conGlobalId} ${stats.sinGlobalId === 0 ? '✅' : '⚠️'}`);
console.log(`   Sin GlobalId:      ${stats.sinGlobalId} ${stats.sinGlobalId === 0 ? '✅' : '❌ → backfill no corrió'}`);
console.log(`   Synced (pushed):   ${stats.synced}`);
console.log(`   No Synced (pending): ${stats.noSynced}`);

if (stats.sinGlobalId === 0 && rows.length > 0) {
    console.log(`\n✅ Todas las filas tienen GlobalId — migración aplicada correctamente.`);
} else if (stats.sinGlobalId > 0) {
    console.log(`\n❌ Hay filas sin GlobalId — la migración pull+backfill no corrió o falló.`);
    console.log(`   Acción: re-abrir la app con internet y hacer login completo.`);
}

db.close();
