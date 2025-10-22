#!/usr/bin/env node
/**
 * Script para crear tablas de asignaciones a repartidores y liquidaciones
 * Trackea kilos asignados, devueltos y vendidos por empleado y sucursal
 */

const { Pool } = require('pg');
const dotenv = require('dotenv');

dotenv.config();

const pool = new Pool({
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
});

async function createTablesIfNotExist() {
  try {
    console.log('🔧 Iniciando creación de tablas de asignaciones a repartidores...\n');

    // ═══════════════════════════════════════════════════════════════
    // 1. TABLA: repartidor_assignments
    // Trackea cada asignación de kilos a un repartidor
    // ═══════════════════════════════════════════════════════════════
    console.log('📊 Creando tabla repartidor_assignments...');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS repartidor_assignments (
        id SERIAL PRIMARY KEY,
        sale_id INTEGER NOT NULL,
        employee_id INTEGER NOT NULL,
        branch_id INTEGER NOT NULL,
        tenant_id INTEGER NOT NULL,
        cantidad_asignada DECIMAL(10, 2) NOT NULL,
        cantidad_devuelta DECIMAL(10, 2) DEFAULT 0,
        cantidad_vendida DECIMAL(10, 2) GENERATED ALWAYS AS (cantidad_asignada - cantidad_devuelta) STORED,
        monto_asignado DECIMAL(10, 2) NOT NULL,
        monto_devuelto DECIMAL(10, 2) DEFAULT 0,
        monto_vendido DECIMAL(10, 2) GENERATED ALWAYS AS (monto_asignado - monto_devuelto) STORED,
        estado VARCHAR(50) NOT NULL DEFAULT 'asignada', -- 'asignada', 'parcialmente_devuelta', 'completada', 'liquidada'
        fecha_asignacion TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        fecha_devoluciones TIMESTAMP WITH TIME ZONE,
        fecha_liquidacion TIMESTAMP WITH TIME ZONE,
        turno_repartidor_id INTEGER,
        observaciones TEXT,
        synced BOOLEAN DEFAULT false,
        remote_id INTEGER UNIQUE,
        synced_at TIMESTAMP WITH TIME ZONE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT fk_sale FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE CASCADE,
        CONSTRAINT fk_employee FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
        CONSTRAINT fk_branch FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE RESTRICT,
        CONSTRAINT fk_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
        CONSTRAINT check_cantidades CHECK (cantidad_devuelta >= 0 AND cantidad_devuelta <= cantidad_asignada),
        CONSTRAINT check_montos CHECK (monto_devuelto >= 0 AND monto_devuelto <= monto_asignado)
      );
    `);
    console.log('✅ Tabla repartidor_assignments creada\n');

    // ═══════════════════════════════════════════════════════════════
    // 2. TABLA: repartidor_liquidations
    // Registra cada evento de liquidación (finiquito) de un repartidor
    // ═══════════════════════════════════════════════════════════════
    console.log('📊 Creando tabla repartidor_liquidations...');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS repartidor_liquidations (
        id SERIAL PRIMARY KEY,
        employee_id INTEGER NOT NULL,
        branch_id INTEGER NOT NULL,
        tenant_id INTEGER NOT NULL,
        total_kilos_asignados DECIMAL(10, 2) NOT NULL,
        total_kilos_devueltos DECIMAL(10, 2) NOT NULL DEFAULT 0,
        total_kilos_vendidos DECIMAL(10, 2) GENERATED ALWAYS AS (total_kilos_asignados - total_kilos_devueltos) STORED,
        monto_total_asignado DECIMAL(10, 2) NOT NULL,
        monto_total_devuelto DECIMAL(10, 2) NOT NULL DEFAULT 0,
        monto_total_vendido DECIMAL(10, 2) GENERATED ALWAYS AS (monto_total_asignado - monto_total_devuelto) STORED,
        total_gastos DECIMAL(10, 2) DEFAULT 0, -- Combustible, mantenimiento, etc.
        neto_a_entregar DECIMAL(10, 2) NOT NULL,
        diferencia_dinero DECIMAL(10, 2), -- Positivo=Sobrepago, Negativo=Deuda
        observaciones TEXT,
        fecha_liquidacion TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        turno_repartidor_id INTEGER,
        synced BOOLEAN DEFAULT false,
        remote_id INTEGER UNIQUE,
        synced_at TIMESTAMP WITH TIME ZONE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT fk_employee FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
        CONSTRAINT fk_branch FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE RESTRICT,
        CONSTRAINT fk_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
      );
    `);
    console.log('✅ Tabla repartidor_liquidations creada\n');

    // ═══════════════════════════════════════════════════════════════
    // 3. TABLA: repartidor_debts
    // Trackea dinero adeudado por repartidores (si venden menos que lo asignado)
    // ═══════════════════════════════════════════════════════════════
    console.log('📊 Creando tabla repartidor_debts...');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS repartidor_debts (
        id SERIAL PRIMARY KEY,
        employee_id INTEGER NOT NULL,
        branch_id INTEGER NOT NULL,
        tenant_id INTEGER NOT NULL,
        liquidation_id INTEGER NOT NULL,
        monto_deuda DECIMAL(10, 2) NOT NULL,
        monto_pagado DECIMAL(10, 2) DEFAULT 0,
        estado VARCHAR(50) NOT NULL DEFAULT 'pendiente', -- 'pendiente', 'parcialmente_pagado', 'pagado'
        fecha_deuda TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        fecha_pago TIMESTAMP WITH TIME ZONE,
        notas TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT fk_employee FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
        CONSTRAINT fk_branch FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE RESTRICT,
        CONSTRAINT fk_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
        CONSTRAINT fk_liquidation FOREIGN KEY (liquidation_id) REFERENCES repartidor_liquidations(id) ON DELETE CASCADE,
        CONSTRAINT check_deuda CHECK (monto_pagado >= 0 AND monto_pagado <= monto_deuda)
      );
    `);
    console.log('✅ Tabla repartidor_debts creada\n');

    // ═══════════════════════════════════════════════════════════════
    // 4. CREAR ÍNDICES para optimizar consultas frecuentes
    // ═══════════════════════════════════════════════════════════════
    console.log('📊 Creando índices...');

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_repartidor_assignments_employee_branch
      ON repartidor_assignments(employee_id, branch_id, tenant_id);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_repartidor_assignments_estado
      ON repartidor_assignments(estado, employee_id);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_repartidor_assignments_fecha
      ON repartidor_assignments(fecha_asignacion DESC, employee_id);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_repartidor_liquidations_employee_fecha
      ON repartidor_liquidations(employee_id, fecha_liquidacion DESC);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_repartidor_liquidations_branch_fecha
      ON repartidor_liquidations(branch_id, fecha_liquidacion DESC);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_repartidor_debts_employee_estado
      ON repartidor_debts(employee_id, estado);
    `);

    console.log('✅ Índices creados\n');

    console.log('═══════════════════════════════════════════════════════════');
    console.log('✅ TODAS LAS TABLAS CREADAS EXITOSAMENTE');
    console.log('═══════════════════════════════════════════════════════════\n');

    console.log('📋 Resumen de tablas creadas:');
    console.log('  1. repartidor_assignments - Asignaciones de kilos');
    console.log('  2. repartidor_liquidations - Eventos de liquidación');
    console.log('  3. repartidor_debts - Deudas de repartidores\n');

  } catch (error) {
    console.error('❌ Error creando tablas:', error.message);
    console.error(error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

createTablesIfNotExist();
