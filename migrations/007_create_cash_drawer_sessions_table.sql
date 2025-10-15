-- ═══════════════════════════════════════════════════════════════════════════
-- MIGRACIÓN 007: Crear tabla CASH_DRAWER_SESSIONS (Cortes de Caja)
-- ═══════════════════════════════════════════════════════════════════════════
-- Fecha: 2025-10-14
-- Descripción: Tabla de cortes de caja para monitoreo desde app móvil
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- Crear tabla cash_drawer_sessions
CREATE TABLE IF NOT EXISTS cash_drawer_sessions (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL,
  branch_id INTEGER NOT NULL,
  shift_id INTEGER NOT NULL,
  employee_id INTEGER NOT NULL,
  business_id INTEGER NOT NULL,

  -- Tiempos
  start_time TIMESTAMP NOT NULL,
  close_time TIMESTAMP,
  opened_at TIMESTAMP NOT NULL,  -- Alias para compatibilidad
  closed_at TIMESTAMP,            -- Alias para compatibilidad

  -- Montos calculados al momento del cierre
  initial_amount DECIMAL(10, 2) NOT NULL DEFAULT 0,
  total_cash_sales DECIMAL(10, 2) DEFAULT 0,
  total_card_sales DECIMAL(10, 2) DEFAULT 0,
  total_credit_sales DECIMAL(10, 2) DEFAULT 0,
  total_cash_payments DECIMAL(10, 2) DEFAULT 0,
  total_card_payments DECIMAL(10, 2) DEFAULT 0,
  total_expenses DECIMAL(10, 2) DEFAULT 0,
  total_deposits DECIMAL(10, 2) DEFAULT 0,
  total_withdrawals DECIMAL(10, 2) DEFAULT 0,

  -- Eventos y métricas adicionales
  unregistered_weight_events INTEGER DEFAULT 0,
  scale_connection_events INTEGER DEFAULT 0,
  cancelled_sales INTEGER DEFAULT 0,

  -- Conteo físico y cierre
  expected_cash_in_drawer DECIMAL(10, 2) DEFAULT 0,
  counted_cash DECIMAL(10, 2) DEFAULT 0,
  difference DECIMAL(10, 2) DEFAULT 0,

  -- Notas y estado
  notes TEXT,
  is_closed BOOLEAN DEFAULT FALSE,

  -- Auditoría
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  -- Sincronización
  remote_id INTEGER,
  synced BOOLEAN DEFAULT FALSE,
  synced_at TIMESTAMP
);

-- Índices para consultas rápidas
CREATE INDEX IF NOT EXISTS idx_cash_drawer_tenant_branch ON cash_drawer_sessions(tenant_id, branch_id);
CREATE INDEX IF NOT EXISTS idx_cash_drawer_shift_id ON cash_drawer_sessions(shift_id);
CREATE INDEX IF NOT EXISTS idx_cash_drawer_employee_id ON cash_drawer_sessions(employee_id);
CREATE INDEX IF NOT EXISTS idx_cash_drawer_business_id ON cash_drawer_sessions(business_id);
CREATE INDEX IF NOT EXISTS idx_cash_drawer_start_time ON cash_drawer_sessions(start_time);
CREATE INDEX IF NOT EXISTS idx_cash_drawer_is_closed ON cash_drawer_sessions(is_closed);

-- Índice único por turno (un solo corte por turno)
CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_drawer_unique_shift
ON cash_drawer_sessions(shift_id);

-- Índice compuesto para consultas de dashboard
CREATE INDEX IF NOT EXISTS idx_cash_drawer_tenant_branch_date
ON cash_drawer_sessions(tenant_id, branch_id, start_time);

-- Foreign keys
ALTER TABLE cash_drawer_sessions
ADD CONSTRAINT fk_cash_drawer_shift
FOREIGN KEY (shift_id)
REFERENCES shifts(id)
ON DELETE CASCADE;

-- Trigger para actualizar updated_at
CREATE OR REPLACE FUNCTION update_cash_drawer_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_cash_drawer_updated_at ON cash_drawer_sessions;

CREATE TRIGGER trigger_update_cash_drawer_updated_at
BEFORE UPDATE ON cash_drawer_sessions
FOR EACH ROW
EXECUTE FUNCTION update_cash_drawer_updated_at();

-- Trigger para sincronizar opened_at y closed_at con start_time y close_time
CREATE OR REPLACE FUNCTION sync_cash_drawer_times()
RETURNS TRIGGER AS $$
BEGIN
  NEW.opened_at = NEW.start_time;
  NEW.closed_at = NEW.close_time;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_sync_cash_drawer_times ON cash_drawer_sessions;

CREATE TRIGGER trigger_sync_cash_drawer_times
BEFORE INSERT OR UPDATE ON cash_drawer_sessions
FOR EACH ROW
EXECUTE FUNCTION sync_cash_drawer_times();

-- Vista completa para la app móvil
CREATE OR REPLACE VIEW v_cash_drawer_sessions_complete AS
SELECT
  cd.id,
  cd.tenant_id,
  cd.branch_id,
  b.name as branch_name,
  b.branch_code,
  cd.shift_id,
  cd.employee_id,
  e.full_name as employee_name,
  e.username as employee_username,
  cd.business_id,
  cd.start_time,
  cd.close_time,
  cd.opened_at,
  cd.closed_at,
  cd.initial_amount,
  cd.total_cash_sales,
  cd.total_card_sales,
  cd.total_credit_sales,
  cd.total_cash_payments,
  cd.total_card_payments,
  cd.total_expenses,
  cd.total_deposits,
  cd.total_withdrawals,
  cd.unregistered_weight_events,
  cd.scale_connection_events,
  cd.cancelled_sales,
  cd.expected_cash_in_drawer,
  cd.counted_cash,
  cd.difference,
  CASE
    WHEN cd.difference > 0 THEN 'sobrante'
    WHEN cd.difference < 0 THEN 'faltante'
    ELSE 'cuadrado'
  END as balance_status,
  cd.notes,
  cd.is_closed,
  cd.created_at,
  cd.updated_at,
  cd.synced,
  cd.synced_at
FROM cash_drawer_sessions cd
LEFT JOIN branches b ON cd.branch_id = b.id
LEFT JOIN employees e ON cd.employee_id = e.id;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- NOTAS:
-- - Un corte de caja por turno (unique index en shift_id)
-- - expected_cash_in_drawer: Dinero que DEBERÍA haber
-- - counted_cash: Dinero físico contado
-- - difference: Faltante/Sobrante (counted_cash - expected_cash_in_drawer)
-- - is_closed: Indica si el corte ya se realizó
-- - opened_at y closed_at son aliases de start_time y close_time
-- ═══════════════════════════════════════════════════════════════════════════
