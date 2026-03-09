/**
 * Migración: Agregar campos de pago a repartidor_assignments
 *
 * Esta migración agrega los campos necesarios para trackear cómo se liquidó
 * cada asignación individualmente, permitiendo pagos mixtos (efectivo + tarjeta).
 *
 * CAMPOS NUEVOS:
 * - payment_method_id: FK a tipos_pago (1=Efectivo, 2=Tarjeta, 3=Crédito, 4=Mixto)
 * - cash_amount: Monto pagado en efectivo (para pagos mixtos)
 * - card_amount: Monto pagado con tarjeta (para pagos mixtos)
 * - credit_amount: Monto a crédito (si aplica)
 * - amount_received: Monto total recibido
 * - is_credit: Boolean si la asignación fue a crédito
 * - payment_reference: Referencia del pago (voucher, transferencia, etc.)
 * - liquidated_by_employee_id: Empleado que liquidó la asignación
 *
 * PROBLEMA QUE RESUELVE:
 * La app móvil y el dashboard calculaban "DINERO A ENTREGAR" asumiendo que
 * todo lo vendido era efectivo. Con estos campos podemos saber exactamente
 * cuánto fue efectivo, tarjeta o crédito por cada asignación.
 *
 * Ejecutar: node run_migration_assignment_payments.js
 */

const { pool } = require('./database');

async function runMigration() {
  console.log('🚀 Iniciando migración: payment fields en repartidor_assignments');

  try {
    // 1. Agregar columnas si no existen
    const columns = [
      { name: 'payment_method_id', type: 'INTEGER REFERENCES tipos_pago(id)' },
      { name: 'cash_amount', type: 'DECIMAL(12, 2)' },
      { name: 'card_amount', type: 'DECIMAL(12, 2)' },
      { name: 'credit_amount', type: 'DECIMAL(12, 2)' },
      { name: 'amount_received', type: 'DECIMAL(12, 2)' },
      { name: 'is_credit', type: 'BOOLEAN DEFAULT FALSE' },
      { name: 'payment_reference', type: 'VARCHAR(255)' },
      { name: 'liquidated_by_employee_id', type: 'INTEGER REFERENCES employees(id)' },
    ];

    for (const col of columns) {
      const checkColumn = await pool.query(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name = 'repartidor_assignments' AND column_name = $1
      `, [col.name]);

      if (checkColumn.rows.length > 0) {
        console.log(`✅ Columna ${col.name} ya existe`);
      } else {
        console.log(`📝 Agregando columna ${col.name}...`);
        await pool.query(`
          ALTER TABLE repartidor_assignments
          ADD COLUMN ${col.name} ${col.type}
        `);
        console.log(`✅ Columna ${col.name} agregada`);
      }
    }

    // 2. Crear índices útiles
    console.log('📝 Creando índices...');

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_repartidor_assignments_payment_method
      ON repartidor_assignments(payment_method_id)
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_repartidor_assignments_liquidated_by
      ON repartidor_assignments(liquidated_by_employee_id)
    `);

    console.log('✅ Índices creados');

    // 3. Migrar datos existentes - asignaciones liquidadas sin payment info
    // Asumimos que fueron pagadas en efectivo por el monto neto
    console.log('📊 Migrando asignaciones liquidadas existentes...');

    // Primero calculamos el monto neto (asignado - devoluciones) para cada asignación liquidada
    const migrateResult = await pool.query(`
      WITH assignment_net AS (
        SELECT
          ra.id,
          ra.assigned_amount,
          COALESCE(SUM(rr.amount), 0) as returned_amount,
          (ra.assigned_amount - COALESCE(SUM(rr.amount), 0)) as net_amount
        FROM repartidor_assignments ra
        LEFT JOIN repartidor_returns rr ON rr.assignment_id = ra.id
          AND (rr.status IS NULL OR rr.status != 'deleted')
        WHERE ra.status = 'liquidated'
          AND ra.payment_method_id IS NULL
        GROUP BY ra.id, ra.assigned_amount
      )
      UPDATE repartidor_assignments ra
      SET
        payment_method_id = 1, -- Efectivo por defecto
        cash_amount = an.net_amount,
        card_amount = 0,
        credit_amount = 0,
        amount_received = an.net_amount,
        is_credit = FALSE
      FROM assignment_net an
      WHERE ra.id = an.id
    `);

    console.log(`✅ ${migrateResult.rowCount} asignaciones migradas con valores por defecto (Efectivo)`);

    // 4. Mostrar estadísticas
    const stats = await pool.query(`
      SELECT
        payment_method_id,
        COUNT(*) as total,
        SUM(cash_amount) as total_cash,
        SUM(card_amount) as total_card,
        SUM(credit_amount) as total_credit
      FROM repartidor_assignments
      WHERE status = 'liquidated'
      GROUP BY payment_method_id
      ORDER BY payment_method_id
    `);

    console.log('\n📊 Estadísticas de asignaciones liquidadas:');
    console.log('────────────────────────────────────────');
    stats.rows.forEach(row => {
      const metodoPago = {
        1: 'Efectivo',
        2: 'Tarjeta',
        3: 'Crédito',
        4: 'Mixto',
        null: 'Sin método'
      }[row.payment_method_id];

      console.log(`  ${metodoPago || 'Desconocido'}:`);
      console.log(`    - Total asignaciones: ${row.total}`);
      console.log(`    - Efectivo: $${parseFloat(row.total_cash || 0).toFixed(2)}`);
      console.log(`    - Tarjeta: $${parseFloat(row.total_card || 0).toFixed(2)}`);
      console.log(`    - Crédito: $${parseFloat(row.total_credit || 0).toFixed(2)}`);
    });

    console.log('\n✅ Migración completada exitosamente');

  } catch (error) {
    console.error('❌ Error en migración:', error.message);
    throw error;
  } finally {
    await pool.end();
  }
}

runMigration();
