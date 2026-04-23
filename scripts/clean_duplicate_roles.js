/**
 * Limpia roles duplicados en la BD local (mismo Name, TenantId, RemoteId).
 * Conserva la fila más antigua (Id menor) y remapea Employee.RoleId que apunten
 * a duplicados hacia el canónico.
 *
 * USO:
 *   node scripts/clean_duplicate_roles.js <db_path>
 */

const dbPath = process.argv[2];
if (!dbPath) {
    console.error('Uso: node scripts/clean_duplicate_roles.js <db_path>');
    process.exit(1);
}

const db = require('better-sqlite3')(dbPath);

// Detectar duplicados por (Name, TenantId)
const dupGroups = db.prepare(`
    SELECT Name, TenantId, COUNT(*) AS cnt, GROUP_CONCAT(Id) AS ids
    FROM Role
    GROUP BY LOWER(Name), TenantId
    HAVING COUNT(*) > 1
`).all();

if (dupGroups.length === 0) {
    console.log('✅ No hay roles duplicados.');
    db.close();
    process.exit(0);
}

console.log(`⚠️  Encontrados ${dupGroups.length} grupos de duplicados:\n`);

const remapStmt = db.prepare('UPDATE Employee SET RoleId = ? WHERE RoleId = ?');
const deleteStmt = db.prepare('DELETE FROM Role WHERE Id = ?');

// La tabla de permisos puede llamarse distinto — detectar y preparar stmt apropiado.
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name);
const rolePermTable = tables.find(n => /role.*permission/i.test(n));
const deleteRolePermsStmt = rolePermTable
    ? db.prepare(`DELETE FROM ${rolePermTable} WHERE RoleId = ?`)
    : null;
console.log(`   (tabla role-permissions: ${rolePermTable ?? 'no existe — se omite'})`);

const tx = db.transaction(() => {
    for (const g of dupGroups) {
        const ids = g.ids.split(',').map(Number).sort((a, b) => a - b);
        const keeper = ids[0];
        const toDelete = ids.slice(1);

        console.log(`🔧 "${g.Name}" (Tenant=${g.TenantId}): conservar Id=${keeper}, eliminar Ids=[${toDelete.join(', ')}]`);

        for (const dupId of toDelete) {
            // Remapear empleados que apunten al duplicado
            const remapped = remapStmt.run(keeper, dupId);
            if (remapped.changes > 0) {
                console.log(`   ↪️  Remapeados ${remapped.changes} Employee(s) de RoleId=${dupId} → ${keeper}`);
            }
            // Borrar role-permissions del duplicado (si la tabla existe)
            if (deleteRolePermsStmt) {
                const permsDel = deleteRolePermsStmt.run(dupId);
                if (permsDel.changes > 0) {
                    console.log(`   🧹 Borrados ${permsDel.changes} role-permissions del duplicado`);
                }
            }
            // Borrar el rol duplicado
            deleteStmt.run(dupId);
            console.log(`   ❌ Role Id=${dupId} borrado`);
        }
    }
});

tx();

// Verificar
const after = db.prepare(`
    SELECT Name, TenantId, COUNT(*) AS cnt
    FROM Role GROUP BY LOWER(Name), TenantId HAVING COUNT(*) > 1
`).all();

console.log(after.length === 0 ? '\n✅ Sin duplicados tras limpieza.' : '\n⚠️ Aún quedan duplicados.');
db.close();
