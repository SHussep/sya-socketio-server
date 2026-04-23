// Diagnóstico 1-a-1 local SQLite vs PostgreSQL para tenant 18 / branch 20
// Ejecutar: node diagnose-tenant-18.js

require('dotenv').config();
const { Pool } = require('pg');
const Database = require('better-sqlite3');

const TENANT_ID = 18;
const BRANCH_ID = 20;
const LOCAL_DB = 'C:\\Users\\saul_\\AppData\\Local\\packages\\40249SaulCorona.SYATortillerias_3q9sdmdf41emt\\LocalState\\SYATortillerias.db3';

const pg = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const sq = new Database(LOCAL_DB, { readonly: true });

function toSet(rows, key) { return new Set(rows.map(r => r[key]).filter(Boolean)); }
function diff(a, b) { return [...a].filter(x => !b.has(x)); }
function pad(s, n) { return String(s).padEnd(n); }

function header(title) {
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  ' + title);
  console.log('═══════════════════════════════════════════════════════════');
}

async function compareByGlobalId(name, pgTable, pgExtraWhere, sqlTable, sqlExtraWhere) {
  header(name);

  const pgSql = `SELECT global_id FROM ${pgTable} WHERE tenant_id=$1 AND branch_id=$2 ${pgExtraWhere || ''}`;
  const pgRows = (await pg.query(pgSql, [TENANT_ID, BRANCH_ID])).rows;

  const hasRemoteId = sq.prepare(`SELECT COUNT(*) AS c FROM pragma_table_info('${sqlTable}') WHERE name='RemoteId'`).get().c > 0;
  const remoteIdCol = hasRemoteId ? 'RemoteId' : 'NULL AS RemoteId';
  const sqlSql = `SELECT GlobalId AS global_id, Synced, ${remoteIdCol} FROM ${sqlTable} WHERE TenantId=${TENANT_ID} AND BranchId=${BRANCH_ID} ${sqlExtraWhere || ''}`;
  const sqlRows = sq.prepare(sqlSql).all();

  const pgIds = toSet(pgRows, 'global_id');
  const sqlIds = toSet(sqlRows, 'global_id');

  const localOnly = diff(sqlIds, pgIds);
  const pgOnly = diff(pgIds, sqlIds);

  // Filas locales marcadas Synced=1 pero NO presentes en Postgres = FALLO SILENCIOSO
  const sqlSyncedMap = new Map(sqlRows.map(r => [r.global_id, r]));
  const silentFailures = localOnly.filter(gid => sqlSyncedMap.get(gid)?.Synced === 1);
  const pendingSync = localOnly.filter(gid => sqlSyncedMap.get(gid)?.Synced !== 1);

  // Duplicados por GlobalId (no deberían existir — columna es UNIQUE en ambos lados)
  const pgDupes = pgRows.length - pgIds.size;
  const sqlDupes = sqlRows.length - sqlIds.size;
  const sqlNullGid = sqlRows.filter(r => !r.global_id).length;

  console.log(`Local (SQLite):     ${pgRows.length === sqlRows.length ? '✓' : ' '} ${sqlRows.length} filas  (GlobalId únicos: ${sqlIds.size}, NULL: ${sqlNullGid})`);
  console.log(`Remoto (Postgres):    ${pgRows.length} filas  (global_id únicos: ${pgIds.size})`);
  console.log(`  Solo local (no en pg):        ${localOnly.length}`);
  console.log(`    └─ pendientes de sync:        ${pendingSync.length}  ← normales, Synced=0`);
  console.log(`    └─ FALLO SILENCIOSO:          ${silentFailures.length}  ← Synced=1 local, ausentes en pg ⚠`);
  console.log(`  Solo en pg (no en local):     ${pgOnly.length}  ← datos huérfanos o backfill`);
  if (sqlDupes > 0) console.log(`  ⚠ Duplicados GlobalId en local: ${sqlDupes}`);
  if (pgDupes > 0) console.log(`  ⚠ Duplicados global_id en pg: ${pgDupes}`);

  if (silentFailures.length > 0) {
    console.log(`\n  Primeros 5 FALLOS SILENCIOSOS (Synced=1 local, no en pg):`);
    silentFailures.slice(0, 5).forEach(gid => {
      const r = sqlSyncedMap.get(gid);
      console.log(`    - ${gid}  RemoteId=${r.RemoteId}`);
    });
  }
  if (pendingSync.length > 0 && pendingSync.length <= 20) {
    console.log(`\n  Pendientes (se sincronizarán al reconectar):`);
    pendingSync.slice(0, 20).forEach(gid => console.log(`    - ${gid}`));
  }
  if (pgOnly.length > 0 && pgOnly.length <= 10) {
    console.log(`\n  Solo en Postgres (primeros 10):`);
    pgOnly.slice(0, 10).forEach(gid => console.log(`    - ${gid}`));
  }
}

async function compareLiquidations() {
  header('RepartidorLiquidations (match por RemoteId, no tiene GlobalId)');

  const pgRows = (await pg.query(
    `SELECT id FROM repartidor_liquidations WHERE tenant_id=$1 AND branch_id=$2`,
    [TENANT_ID, BRANCH_ID]
  )).rows;
  const sqlRows = sq.prepare(
    `SELECT Id, RemoteId, Synced FROM RepartidorLiquidations WHERE TenantId=${TENANT_ID} AND BranchId=${BRANCH_ID}`
  ).all();

  const pgIds = new Set(pgRows.map(r => r.id));
  const sqlWithRemote = sqlRows.filter(r => r.RemoteId);
  const sqlRemoteIds = new Set(sqlWithRemote.map(r => r.RemoteId));
  const unsynced = sqlRows.filter(r => !r.RemoteId || r.Synced !== 1);
  const syncedButMissingInPg = sqlWithRemote.filter(r => !pgIds.has(r.RemoteId));
  const pgOrphans = [...pgIds].filter(id => !sqlRemoteIds.has(id));

  console.log(`Local: ${sqlRows.length} filas (${sqlWithRemote.length} con RemoteId, ${unsynced.length} pendientes)`);
  console.log(`Postgres: ${pgRows.length} filas`);
  console.log(`  FALLO SILENCIOSO (Synced=1 pero RemoteId no existe en pg): ${syncedButMissingInPg.length}`);
  console.log(`  Solo en pg (RemoteId huérfano): ${pgOrphans.length}`);
}

(async () => {
  try {
    // 1. Ventas (no canceladas, no borrador)
    await compareByGlobalId(
      'VENTAS (excluyendo borrador=1 y canceladas=4)',
      'ventas',
      `AND estado_venta_id NOT IN (1, 4)`,
      'Ventas',
      `AND EstadoVentaId NOT IN (1, 4)`
    );

    // 2. Expenses (no deleted)
    await compareByGlobalId(
      'GASTOS (excluyendo status=deleted en pg, IsDeleted=1 en local)',
      'expenses',
      `AND status != 'deleted'`,
      'Expense',
      `AND IsDeleted = 0`
    );

    // 3. CashCuts / CashDrawerSessions
    await compareByGlobalId(
      'CORTES DE CAJA (CashDrawerSessions vs cash_cuts)',
      'cash_cuts',
      '',
      'CashDrawerSessions',
      ''
    );

    // 4. Repartidor assignments
    await compareByGlobalId(
      'REPARTIDOR ASSIGNMENTS',
      'repartidor_assignments',
      '',
      'RepartidorAssignments',
      ''
    );

    // 5. Liquidaciones (por RemoteId)
    await compareLiquidations();

    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('  Diagnóstico completado');
    console.log('═══════════════════════════════════════════════════════════\n');
  } catch (e) {
    console.error('ERROR:', e.message);
    console.error(e.stack);
  } finally {
    await pg.end();
    sq.close();
  }
})();
