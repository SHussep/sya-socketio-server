-- =====================================================
-- Migration: 057_create_guardian_tables.sql
-- Descripción: Crear tablas para Guardian (monitoreo de báscula)
-- =====================================================
-- Guardian monitorea:
-- 1. Desconexiones de báscula (duración, empleado, terminal)
-- 2. Eventos sospechosos de pesaje (peso inusual, delta, etc.)
-- 3. Puntajes de empleados (agregados diarios)
-- =====================================================

-- ========== TABLA: scale_disconnections ==========
-- Registra cada vez que la báscula se desconecta y reconecta
CREATE TABLE IF NOT EXISTS scale_disconnections (
  id SERIAL PRIMARY KEY,

  -- Scope
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  terminal_id VARCHAR(100) NOT NULL,

  -- Empleado responsable (si había sesión activa)
  employee_remote_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,

  -- Timestamps de desconexión/reconexión
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,

  -- Duración calculada automáticamente (segundos)
  duration_seconds INTEGER GENERATED ALWAYS AS (
    CASE
      WHEN ended_at IS NULL THEN NULL
      ELSE EXTRACT(EPOCH FROM (ended_at - started_at))::INTEGER
    END
  ) STORED,

  -- Contexto adicional
  reason VARCHAR(255),                  -- 'unplugged', 'timeout', 'power_loss', etc.
  port VARCHAR(100),                    -- Puerto COM de la báscula
  context JSONB,                        -- Información adicional

  -- Offline-first: GlobalId para idempotencia
  external_key VARCHAR(255) UNIQUE NOT NULL,  -- GlobalId desde Desktop

  -- Auditoría
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Índices para scale_disconnections
CREATE INDEX IF NOT EXISTS idx_scale_disconnections_scope ON scale_disconnections(tenant_id, branch_id, started_at);
CREATE INDEX IF NOT EXISTS idx_scale_disconnections_employee ON scale_disconnections(tenant_id, employee_remote_id, started_at)
  WHERE employee_remote_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_scale_disconnections_terminal ON scale_disconnections(terminal_id, started_at);
CREATE INDEX IF NOT EXISTS idx_scale_disconnections_open ON scale_disconnections(tenant_id, branch_id, started_at)
  WHERE ended_at IS NULL;  -- Desconexiones aún abiertas

-- ========== TABLA: suspicious_weighing_events ==========
-- Registra eventos sospechosos durante el pesaje
CREATE TABLE IF NOT EXISTS suspicious_weighing_events (
  id SERIAL PRIMARY KEY,

  -- Scope
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  terminal_id VARCHAR(100) NOT NULL,

  -- Empleado que realizó el pesaje
  employee_remote_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,

  -- Timestamp del evento
  event_at TIMESTAMPTZ NOT NULL,

  -- Tipo de evento sospechoso
  event_type VARCHAR(50) NOT NULL,
  -- Valores posibles: 'rapid_weight_change', 'negative_weight', 'zero_after_product',
  --                   'weight_mismatch', 'scale_manipulation', 'unusual_tare', etc.

  -- Producto involucrado (opcional)
  product_external_key VARCHAR(255),    -- GlobalId del producto

  -- Datos del peso
  weight NUMERIC(10,3),                 -- Peso registrado (kg)
  delta NUMERIC(10,3),                  -- Delta vs peso esperado
  context JSONB,                        -- Detalles: modo, producto, precio, etc.

  -- Offline-first: GlobalId para idempotencia
  external_key VARCHAR(255) UNIQUE NOT NULL,  -- GlobalId desde Desktop

  -- Auditoría
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Índices para suspicious_weighing_events
CREATE INDEX IF NOT EXISTS idx_suspicious_weighing_scope ON suspicious_weighing_events(tenant_id, branch_id, event_at);
CREATE INDEX IF NOT EXISTS idx_suspicious_weighing_employee ON suspicious_weighing_events(tenant_id, employee_remote_id, event_at);
CREATE INDEX IF NOT EXISTS idx_suspicious_weighing_type ON suspicious_weighing_events(tenant_id, branch_id, event_type);
CREATE INDEX IF NOT EXISTS idx_suspicious_weighing_product ON suspicious_weighing_events(product_external_key)
  WHERE product_external_key IS NOT NULL;

-- ========== TABLA: guardian_employee_scores_daily ==========
-- Agregados diarios de puntajes por empleado
CREATE TABLE IF NOT EXISTS guardian_employee_scores_daily (
  -- Composite primary key
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  employee_remote_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  day DATE NOT NULL,

  -- Contadores del día
  suspicious_count INTEGER NOT NULL DEFAULT 0,
  disconnection_count INTEGER NOT NULL DEFAULT 0,
  disconnected_seconds INTEGER NOT NULL DEFAULT 0,

  -- Auditoría
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (tenant_id, branch_id, employee_remote_id, day)
);

-- Índices para guardian_employee_scores_daily
CREATE INDEX IF NOT EXISTS idx_guardian_scores_employee ON guardian_employee_scores_daily(tenant_id, employee_remote_id, day);
CREATE INDEX IF NOT EXISTS idx_guardian_scores_day ON guardian_employee_scores_daily(tenant_id, branch_id, day);

-- Trigger para updated_at
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'update_guardian_scores_updated_at'
  ) THEN
    CREATE TRIGGER update_guardian_scores_updated_at
      BEFORE UPDATE ON guardian_employee_scores_daily
      FOR EACH ROW
      EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;

-- ========== COMENTARIOS ==========
COMMENT ON TABLE scale_disconnections IS 'Registro de desconexiones de báscula con duración calculada';
COMMENT ON COLUMN scale_disconnections.external_key IS 'GlobalId desde Desktop para idempotencia';
COMMENT ON COLUMN scale_disconnections.duration_seconds IS 'Duración en segundos - calculada automáticamente';
COMMENT ON COLUMN scale_disconnections.context IS 'Contexto adicional en formato JSON';

COMMENT ON TABLE suspicious_weighing_events IS 'Eventos sospechosos durante el pesaje';
COMMENT ON COLUMN suspicious_weighing_events.event_type IS 'Tipo de evento: rapid_weight_change, negative_weight, zero_after_product, etc.';
COMMENT ON COLUMN suspicious_weighing_events.external_key IS 'GlobalId desde Desktop para idempotencia';
COMMENT ON COLUMN suspicious_weighing_events.context IS 'Detalles del evento en formato JSON';

COMMENT ON TABLE guardian_employee_scores_daily IS 'Agregados diarios de comportamiento de empleados en báscula';
COMMENT ON COLUMN guardian_employee_scores_daily.suspicious_count IS 'Total de eventos sospechosos del día';
COMMENT ON COLUMN guardian_employee_scores_daily.disconnection_count IS 'Total de desconexiones del día';
COMMENT ON COLUMN guardian_employee_scores_daily.disconnected_seconds IS 'Total de segundos con báscula desconectada';
