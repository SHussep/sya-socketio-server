// Diagnóstico COMPLETO: identifica cada discrepancia por registro,
// no solo cuenta. Muestra qué está en un lado y no en el otro, y con qué datos.

require('dotenv').config();
const { Pool } = require('pg');
const Database = require('better-sqlite3');

const TENANT_ID = 18;
const BRANCH_ID = 20;
const LOCAL_DB = 'C:\\Users\\saul_\\AppData\\Local\\packages\\40249SaulCorona.SYATortillerias_3q9sdmdf41emt\\LocalState\\SYATortillerias.db3';

const pg = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const sq = new Database(LOCAL_DB, { readonly: true });

function hdr(t) { console.log('\n' + '═'.repeat(70) + '\n  ' + t + '\n' + '═'.repeat(70)); }

async function detailDiff(name, pgTable, pgCols, pgFilter, sqlTable, sqlCols, sqlFilter) {
  hdr(name);
  const pgRows = (await pg.query(
    `SELECT ${pgCols}, global_id FROM ${pgTable} WHERE tenant_id=$1 AND branch_id=$2 ${pgFilter}`,
    [TENANT_ID, BRANCH_ID]
  )).rows;
  const sqlRows = sq.prepare(
    `SELECT ${sqlCols}, GlobalId AS global_id, Synced FROM ${sqlTable} WHERE TenantId=${TENANT_ID} AND BranchId=${BRANCH_ID} ${sqlFilter}`
  ).all();

  const pgMap = new Map(pgRows.map(r => [r.global_id, r]));
  const sqMap = new Map(sqlRows.map(r => [r.global_id, r]));

  const onlyLocal = sqlRows.filter(r => r.global_id && !pgMap.has(r.global_id));
  const onlyPg = pgRows.filter(r => r.global_id && !sqMap.has(r.global_id));

  console.log(`  Local=${sqlRows.length}  PG=${pgRows.length}`);

  if (onlyLocal.length > 0) {
    console.log(`\n  ⚠ SOLO EN LOCAL (${onlyLocal.length}) — "+N", fallos silenciosos potenciales:`);
    onlyLocal.slice(0, 10).forEach(r => {
      console.log(`    Synced=${r.Synced}  ${JSON.stringify(r).slice(0, 160)}`);
    });
    if (onlyLocal.length > 10) console.log(`    ... y ${onlyLocal.length - 10} más`);
  }
  if (onlyPg.length > 0) {
    console.log(`\n  ⚠ SOLO EN POSTGRES (${onlyPg.length}) — "-N", falta hacer pull-from-server:`);
    onlyPg.slice(0, 10).forEach(r => {
      console.log(`    ${JSON.stringify(r).slice(0, 200)}`);
    });
    if (onlyPg.length > 10) console.log(`    ... y ${onlyPg.length - 10} más`);
  }
  if (onlyLocal.length === 0 && onlyPg.length === 0) {
    console.log(`  ✅ Coinciden 1:1`);
  }
}

(async () => {
  try {
    await detailDiff(
      'TURNOS (-1 faltan según UI)',
      'shifts', 'id, employee_id, start_time, end_time, is_closed, status', '',
      'Shift', 'Id, EmployeeId, StartTime, EndTime, IsClosed', ''
    );

    await detailDiff(
      'CATEGORÍAS (-10 faltan)',
      'product_categories', 'id, name, is_active', '',
      'CategoriasProductos', 'Id, Name, IsActive', ''
    );

    await detailDiff(
      'PRODUCTOS (-1 falta)',
      'productos', 'id_producto, descripcion, activo', '',
      'Productos', 'IdProducto, Descripcion, Activo', ''
    );

    await detailDiff(
      'PROVEEDORES (-1 falta)',
      'suppliers', 'id, name, is_active', '',
      'Proveedores', 'Id, Name, IsActive', ''
    );

    await detailDiff(
      'GUARDIAN LOGS (-5 faltan)',
      'suspicious_weighing_logs', 'id, employee_id, created_at', '',
      'SuspiciousWeighingLogs', 'Id, EmployeeId, CreatedAt', ''
    );

    await detailDiff(
      'DESCONEXIONES BÁSCULA (-4 faltan)',
      'scale_disconnection_logs', 'id, employee_id, disconnected_at', '',
      'ScaleDisconnectionLogs', 'Id, EmployeeId, DisconnectedAt', ''
    );

    await detailDiff(
      'ASIGNACIONES (-2 faltan — ya las conocemos)',
      'repartidor_assignments', 'id, status, fecha_asignacion', '',
      'RepartidorAssignments', 'Id, Status, FechaAsignacion', ''
    );

    await detailDiff(
      'CORTES DE CAJA (+6 — fallos silenciosos)',
      'cash_cuts', 'id, end_time, is_closed', '',
      'CashDrawerSessions', 'Id, CloseTime, IsClosed', ''
    );

  } catch (e) {
    console.error('ERROR:', e.message);
  } finally {
    await pg.end();
    sq.close();
  }
})();
