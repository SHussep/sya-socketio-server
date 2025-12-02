/**
 * Migración: Crear tabla employee_debts
 *
 * Esta tabla almacena las deudas de empleados generadas por faltantes
 * en cortes de caja (cash_drawer_sessions.difference < 0)
 *
 * Ejecutar: node run_migration_employee_debts.js
 */

const { pool } = require('./database');

async function runMigration() {
  console.log('🚀 Iniciando migración: employee_debts');

  try {
    // Crear tabla employee_debts
    await pool.query(`
      CREATE TABLE IF NOT EXISTS employee_debts (
        id SERIAL PRIMARY KEY,
        global_id VARCHAR(50) UNIQUE NOT NULL,
        tenant_id INTEGER NOT NULL REFERENCES tenants(id),
        branch_id INTEGER NOT NULL REFERENCES branches(id),
        employee_id INTEGER NOT NULL REFERENCES employees(id),
        cash_drawer_session_id INTEGER REFERENCES cash_drawer_sessions(id),
        shift_id INTEGER REFERENCES shifts(id),

        -- Datos de la deuda
        monto_deuda DECIMAL(12, 2) NOT NULL DEFAULT 0,
        monto_pagado DECIMAL(12, 2) NOT NULL DEFAULT 0,
        estado VARCHAR(30) NOT NULL DEFAULT 'pendiente', -- pendiente | parcialmente_pagado | pagado
        fecha_deuda TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        fecha_pago TIMESTAMP WITH TIME ZONE,
        notas TEXT,

        -- Campos offline-first para idempotencia
        terminal_id VARCHAR(50),
        local_op_seq BIGINT,
        device_event_raw BIGINT,
        created_local_utc VARCHAR(50),

        -- Timestamps
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);
    console.log('✅ Tabla employee_debts creada');

    // Crear índices
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_employee_debts_tenant ON employee_debts(tenant_id);
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_employee_debts_branch ON employee_debts(branch_id);
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_employee_debts_employee ON employee_debts(employee_id);
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_employee_debts_estado ON employee_debts(estado);
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_employee_debts_fecha ON employee_debts(fecha_deuda);
    `);
    console.log('✅ Índices creados');

    // Verificar estructura
    const result = await pool.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'employee_debts'
      ORDER BY ordinal_position;
    `);

    console.log('\n📋 Estructura de employee_debts:');
    result.rows.forEach(col => {
      console.log(`  - ${col.column_name}: ${col.data_type} (${col.is_nullable === 'YES' ? 'nullable' : 'required'})`);
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
