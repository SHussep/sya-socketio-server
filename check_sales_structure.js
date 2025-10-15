const { Pool } = require('pg');

const pool = new Pool({
  host: 'dpg-d3i8dv3e5dus738tm5rg-a.oregon-postgres.render.com',
  user: 'sya_admin',
  password: 'qJ1haIaPp7m7OFMyicWSplPlGoNL1GpF',
  database: 'sya_db_oe4v',
  port: 5432,
  ssl: { rejectUnauthorized: false }
});

async function checkSalesStructure() {
  try {
    console.log('📊 Revisando estructura actual de tabla sales...\n');

    // Ver columnas actuales
    const columnsQuery = `
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = 'sales'
      ORDER BY ordinal_position;
    `;

    const { rows: columns } = await pool.query(columnsQuery);

    console.log('═══════════════════════════════════════════════════════');
    console.log('COLUMNAS ACTUALES EN TABLA SALES:');
    console.log('═══════════════════════════════════════════════════════\n');

    columns.forEach(col => {
      console.log(`  ${col.column_name.padEnd(30)} ${col.data_type.padEnd(20)} ${col.is_nullable === 'YES' ? 'NULL' : 'NOT NULL'}`);
    });

    // Ver ejemplo de ventas recientes
    console.log('\n═══════════════════════════════════════════════════════');
    console.log('EJEMPLO DE VENTAS RECIENTES (últimas 5):');
    console.log('═══════════════════════════════════════════════════════\n');

    const salesQuery = `
      SELECT * FROM sales
      ORDER BY sale_date DESC
      LIMIT 5;
    `;

    const { rows: sales } = await pool.query(salesQuery);

    if (sales.length > 0) {
      console.log(JSON.stringify(sales[0], null, 2));
      console.log(`\n... y ${sales.length - 1} ventas más`);
    } else {
      console.log('No hay ventas en la base de datos');
    }

    // Analizar columnas faltantes críticas
    console.log('\n═══════════════════════════════════════════════════════');
    console.log('ANÁLISIS DE CAMPOS CRÍTICOS:');
    console.log('═══════════════════════════════════════════════════════\n');

    const criticalFields = {
      'shift_id': '❌ NO - Necesario para identificar turno único',
      'employee_id': '?',
      'branch_id': '?',
      'payment_method': '?',
      'payment_type': '?',
      'is_credit': '?',
      'ticket_number': '?'
    };

    const columnNames = columns.map(c => c.column_name);

    Object.entries(criticalFields).forEach(([field, status]) => {
      const exists = columnNames.includes(field);
      const symbol = exists ? '✅ SÍ' : '❌ NO';
      console.log(`  ${field.padEnd(30)} ${symbol}`);
    });

    pool.end();
  } catch (error) {
    console.error('❌ Error:', error.message);
    pool.end();
    process.exit(1);
  }
}

checkSalesStructure();
