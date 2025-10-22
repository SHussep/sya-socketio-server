#!/usr/bin/env node

/**
 * Verificar que la venta #13 se guardó correctamente en la BD
 */

const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function verifySale() {
  const client = await pool.connect();

  try {
    console.log('🔍 Buscando venta #13...\n');

    const result = await client.query(
      `SELECT * FROM sales WHERE ticket_number = $1 AND tenant_id = $2 ORDER BY id DESC LIMIT 1`,
      [13, 3]
    );

    if (result.rows.length === 0) {
      console.log('❌ No se encontró venta #13 para tenant 3');
      process.exit(1);
    }

    const sale = result.rows[0];

    console.log('✅ VENTA ENCONTRADA:\n');
    console.log(`  ID: ${sale.id}`);
    console.log(`  Ticket: #${sale.ticket_number}`);
    console.log(`  Total: $${sale.total_amount}`);
    console.log(`  Método: ${sale.payment_method}`);
    console.log(`  Tipo: ${sale.sale_type}`);
    console.log(`  Fecha: ${sale.sale_date}`);
    console.log(`  Empleado: ${sale.employee_id}`);
    console.log(`  Sucursal: ${sale.branch_id}`);

    console.log('\n═════════════════════════════════════════');
    console.log('🎉 ¡LA VENTA SE GUARDÓ CORRECTAMENTE!');
    console.log('═════════════════════════════════════════\n');

  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    client.release();
    await pool.end();
  }
}

verifySale();
