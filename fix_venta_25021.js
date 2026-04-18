require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function fix() {
  // 1. Check current state
  const before = await pool.query(
    `SELECT id_venta, estado_venta_id, venta_tipo_id, total, monto_pagado, global_id
     FROM ventas WHERE id_venta = 25021 AND tenant_id = 82`
  );
  console.log('ANTES:', before.rows[0]);

  // 2. Check assignments on this venta
  const assignments = await pool.query(
    `SELECT id, status, assigned_quantity, assigned_amount, product_name
     FROM repartidor_assignments WHERE venta_id = 25021 AND tenant_id = 82`
  );
  console.log('Assignments:', assignments.rows);

  // 3. Fix: set estado_venta_id=2 (Asignada) since assignments are pending
  const hasLiquidated = assignments.rows.some(a => a.status === 'liquidated');
  const allCancelled = assignments.rows.every(a => a.status === 'cancelled');

  let newEstado;
  if (allCancelled || assignments.rows.length === 0) {
    newEstado = 4; // Cancelada
  } else if (hasLiquidated) {
    newEstado = 5; // Liquidada
  } else {
    newEstado = 2; // Asignada (pending)
  }

  await pool.query(
    `UPDATE ventas SET estado_venta_id = $1, monto_pagado = 0, cash_amount = 0, card_amount = 0, credit_amount = 0, updated_at = NOW()
     WHERE id_venta = 25021 AND tenant_id = 82`,
    [newEstado]
  );

  // 4. Verify
  const after = await pool.query(
    `SELECT id_venta, estado_venta_id, venta_tipo_id, total, monto_pagado
     FROM ventas WHERE id_venta = 25021 AND tenant_id = 82`
  );
  console.log('DESPUÉS:', after.rows[0]);
  console.log(`Estado cambiado a: ${newEstado} (${newEstado === 2 ? 'Asignada' : newEstado === 4 ? 'Cancelada' : 'Liquidada'})`);

  await pool.end();
}

fix().catch(e => { console.error(e); process.exit(1); });
