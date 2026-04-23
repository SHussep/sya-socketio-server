require('dotenv').config();
const { Pool } = require('pg');
const pg = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

(async () => {
  try {
    console.log('=== Tablas de monitoreo / liquidaciones: existen en Postgres? ===');
    const checkTables = [
      'suspicious_weighing_logs',
      'guardian_logs',
      'scale_disconnection_logs',
      'employee_daily_metrics',
      'repartidor_liquidations',
      'preparation_mode_logs'
    ];
    for (const t of checkTables) {
      const r = await pg.query(
        "SELECT COUNT(*) FROM information_schema.tables WHERE table_name=$1",
        [t]
      );
      console.log(`  ${t.padEnd(30)} -> ${r.rows[0].count > 0 ? '✓ existe' : '✗ NO EXISTE'}`);
    }

    console.log('\n=== Investigar las 2 REPARTIDOR_ASSIGNMENTS solo-en-pg ===');
    const orphans = await pg.query(
      `SELECT global_id, id, fecha_asignacion, status, venta_id, created_at
       FROM repartidor_assignments
       WHERE global_id IN ('ede68b7e-db9c-4a6c-ab29-77467dc44d5d','239a855c-5858-46eb-9d1a-c6ee5fe3608c')`
    );
    console.log(orphans.rows);

    console.log('\n=== Duplicados por global_id en pg ===');
    for (const t of ['ventas', 'expenses', 'cash_cuts', 'repartidor_assignments']) {
      const d = await pg.query(
        `SELECT global_id, COUNT(*) FROM ${t} WHERE tenant_id=18 AND branch_id=20 GROUP BY global_id HAVING COUNT(*)>1`
      );
      console.log(`  ${t.padEnd(25)} -> ${d.rows.length} global_id duplicados`);
    }

    console.log('\n=== Monitoreo en Postgres (cuentas) ===');
    for (const t of [
      'suspicious_weighing_logs',
      'scale_disconnection_logs',
      'employee_daily_metrics',
      'preparation_mode_logs',
      'guardian_logs'
    ]) {
      try {
        const c = await pg.query(`SELECT COUNT(*) FROM ${t} WHERE tenant_id=18`);
        console.log(`  ${t.padEnd(30)} -> ${c.rows[0].count} filas tenant 18`);
      } catch (e) {
        console.log(`  ${t.padEnd(30)} -> n/a (${e.message.split('\n')[0]})`);
      }
    }

    await pg.end();
  } catch (e) {
    console.error('ERROR:', e.message);
    await pg.end();
  }
})();
