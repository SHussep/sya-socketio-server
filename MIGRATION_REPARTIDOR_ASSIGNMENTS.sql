-- ═══════════════════════════════════════════════════════════════════════════════
-- MIGRATION: Create Repartidor Assignment Tracking Tables
-- Purpose: Implement complete synchronization of delivery assignments and liquidations
-- Date: 2025-10-22
-- ═══════════════════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────────────────────
-- 1. TABLE: repartidor_assignments
-- Tracks each assignment of kilos to a delivery person (repartidor)
-- ───────────────────────────────────────────────────────────────────────────────
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
  estado VARCHAR(50) NOT NULL DEFAULT 'asignada',
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

-- ───────────────────────────────────────────────────────────────────────────────
-- 2. TABLE: repartidor_liquidations
-- Records each liquidation event (finiquito) for a delivery person
-- ───────────────────────────────────────────────────────────────────────────────
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
  total_gastos DECIMAL(10, 2) DEFAULT 0,
  neto_a_entregar DECIMAL(10, 2) NOT NULL,
  diferencia_dinero DECIMAL(10, 2),
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

-- ───────────────────────────────────────────────────────────────────────────────
-- 3. TABLE: repartidor_debts
-- Tracks money owed by delivery persons (if they sell less than assigned)
-- ───────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS repartidor_debts (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL,
  branch_id INTEGER NOT NULL,
  tenant_id INTEGER NOT NULL,
  liquidation_id INTEGER NOT NULL,
  monto_deuda DECIMAL(10, 2) NOT NULL,
  monto_pagado DECIMAL(10, 2) DEFAULT 0,
  estado VARCHAR(50) NOT NULL DEFAULT 'pendiente',
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

-- ───────────────────────────────────────────────────────────────────────────────
-- 4. CREATE INDEXES for query optimization
-- ───────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_repartidor_assignments_employee_branch
ON repartidor_assignments(employee_id, branch_id, tenant_id);

CREATE INDEX IF NOT EXISTS idx_repartidor_assignments_estado
ON repartidor_assignments(estado, employee_id);

CREATE INDEX IF NOT EXISTS idx_repartidor_assignments_fecha
ON repartidor_assignments(fecha_asignacion DESC, employee_id);

CREATE INDEX IF NOT EXISTS idx_repartidor_liquidations_employee_fecha
ON repartidor_liquidations(employee_id, fecha_liquidacion DESC);

CREATE INDEX IF NOT EXISTS idx_repartidor_liquidations_branch_fecha
ON repartidor_liquidations(branch_id, fecha_liquidacion DESC);

CREATE INDEX IF NOT EXISTS idx_repartidor_debts_employee_estado
ON repartidor_debts(employee_id, estado);

-- ═══════════════════════════════════════════════════════════════════════════════
-- MIGRATION COMPLETE
-- Tables created:
--   1. repartidor_assignments - Individual assignment tracking
--   2. repartidor_liquidations - Liquidation event records
--   3. repartidor_debts - Debt tracking for shortfalls
-- ═══════════════════════════════════════════════════════════════════════════════
