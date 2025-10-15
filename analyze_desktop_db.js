const sqlite3 = require('sqlite3').verbose();
const { Pool } = require('pg');
const fs = require('fs');

const DB_PATH = 'C:/Users/saul_/AppData/Local/Packages/6a727d9d-d40f-407d-a7b7-655ca0f8161b_pkzpc8njrvjtr/LocalState/SYATortillerias.db3';

const pool = new Pool({
  host: 'dpg-d3i8dv3e5dus738tm5rg-a.oregon-postgres.render.com',
  user: 'sya_admin',
  password: 'qJ1haIaPp7m7OFMyicWSplPlGoNL1GpF',
  database: 'sya_db_oe4v',
  port: 5432,
  ssl: { rejectUnauthorized: false }
});

async function analyzeDatabase() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READONLY, (err) => {
      if (err) {
        reject(err);
        return;
      }

      console.log('📊 Analizando base de datos SQLite del Desktop...\n');

      // Obtener lista de tablas
      db.all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name", async (err, tables) => {
        if (err) {
          reject(err);
          return;
        }

        const analysis = {};

        for (const table of tables) {
          const tableName = table.name;

          // Obtener estructura de tabla
          const tableInfo = await new Promise((res, rej) => {
            db.all(`PRAGMA table_info(${tableName})`, (err, columns) => {
              if (err) rej(err);
              else res(columns);
            });
          });

          // Obtener conteo de registros
          const count = await new Promise((res, rej) => {
            db.get(`SELECT COUNT(*) as count FROM ${tableName}`, (err, result) => {
              if (err) rej(err);
              else res(result.count);
            });
          });

          analysis[tableName] = {
            columns: tableInfo,
            recordCount: count
          };
        }

        db.close();

        // Verificar qué tablas existen en PostgreSQL
        console.log('═══════════════════════════════════════════════════════');
        console.log('COMPARACIÓN DESKTOP (SQLite) vs CLOUD (PostgreSQL)');
        console.log('═══════════════════════════════════════════════════════\n');

        const { rows: pgTables } = await pool.query(`
          SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        `);

        const pgTableNames = new Set(pgTables.map(t => t.table_name));

        const criticalTables = [
          'Shifts',
          'CashCuts',
          'Expenses',
          'ExpenseCategories',
          'Purchases',
          'DeliveryAssignments',
          'Sales',
          'SaleItems',
          'Products',
          'Clientes',
          'Employees',
          'GuardianEvents'
        ];

        for (const tableName of criticalTables) {
          const lowerName = tableName.toLowerCase();
          const existsInPg = pgTableNames.has(lowerName);
          const existsInSqlite = analysis[tableName] !== undefined;

          console.log(`\n📋 Tabla: ${tableName}`);
          console.log(`   Desktop (SQLite): ${existsInSqlite ? '✅ SÍ' : '❌ NO'} ${existsInSqlite ? `(${analysis[tableName].recordCount} registros)` : ''}`);
          console.log(`   Cloud (PostgreSQL): ${existsInPg ? '✅ SÍ' : '❌ NO'}`);

          if (existsInSqlite) {
            console.log(`   Columnas en Desktop:`);
            analysis[tableName].columns.forEach(col => {
              console.log(`      - ${col.name.padEnd(30)} ${col.type.padEnd(15)} ${col.notnull ? 'NOT NULL' : 'NULL'}`);
            });

            if (existsInPg) {
              // Comparar columnas
              const { rows: pgColumns } = await pool.query(`
                SELECT column_name, data_type, is_nullable
                FROM information_schema.columns
                WHERE table_name = $1
                ORDER BY ordinal_position
              `, [lowerName]);

              const pgColNames = new Set(pgColumns.map(c => c.column_name));
              const sqliteColNames = new Set(analysis[tableName].columns.map(c => c.name.toLowerCase()));

              const missing = analysis[tableName].columns
                .filter(c => !pgColNames.has(c.name.toLowerCase()))
                .map(c => c.name);

              if (missing.length > 0) {
                console.log(`   ⚠️  Columnas FALTANTES en PostgreSQL:`);
                missing.forEach(col => console.log(`      ❌ ${col}`));
              }
            }
          }
        }

        // Guardar análisis completo
        fs.writeFileSync(
          'C:/SYA/sya-socketio-server/desktop_db_analysis.json',
          JSON.stringify(analysis, null, 2)
        );

        console.log('\n✅ Análisis completado y guardado en desktop_db_analysis.json\n');

        pool.end();
        resolve(analysis);
      });
    });
  });
}

analyzeDatabase().catch(error => {
  console.error('❌ Error:', error);
  pool.end();
  process.exit(1);
});
