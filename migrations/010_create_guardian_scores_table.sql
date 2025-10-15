-- ═══════════════════════════════════════════════════════════════════════════
-- MIGRACIÓN 010: Crear tabla GUARDIAN_EMPLOYEE_SCORES (Guardian)
-- ═══════════════════════════════════════════════════════════════════════════
-- Fecha: 2025-10-14
-- Descripción: Tabla de puntuaciones Guardian para monitoreo de empleados
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- Crear tabla guardian_employee_scores
CREATE TABLE IF NOT EXISTS guardian_employee_scores (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL,
  branch_id INTEGER NOT NULL,
  employee_id INTEGER NOT NULL,

  -- Puntuación y eventos
  score DECIMAL(10, 2) DEFAULT 0,
  critical_events INTEGER DEFAULT 0,
  high_events INTEGER DEFAULT 0,
  moderate_events INTEGER DEFAULT 0,
  low_events INTEGER DEFAULT 0,
  informative_events INTEGER DEFAULT 0,

  -- Últimos puntos y eventos
  last_points_applied DECIMAL(10, 2),
  last_event_at TIMESTAMP,
  last_critical_event_at TIMESTAMP,
  last_high_or_critical_event_at TIMESTAMP,

  -- Decaimiento y reset
  last_decay_applied TIMESTAMP,
  last_reset_at TIMESTAMP,

  -- Banda de riesgo
  score_band VARCHAR(50),  -- 'verde', 'amarillo', 'naranja', 'rojo'

  -- Auditoría
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  -- Sincronización
  remote_id INTEGER,
  synced BOOLEAN DEFAULT FALSE,
  synced_at TIMESTAMP
);

-- Índices para consultas rápidas
CREATE INDEX IF NOT EXISTS idx_guardian_tenant_branch ON guardian_employee_scores(tenant_id, branch_id);
CREATE INDEX IF NOT EXISTS idx_guardian_employee_id ON guardian_employee_scores(employee_id);
CREATE INDEX IF NOT EXISTS idx_guardian_score ON guardian_employee_scores(score);
CREATE INDEX IF NOT EXISTS idx_guardian_score_band ON guardian_employee_scores(score_band);
CREATE INDEX IF NOT EXISTS idx_guardian_last_event ON guardian_employee_scores(last_event_at);
CREATE INDEX IF NOT EXISTS idx_guardian_last_critical ON guardian_employee_scores(last_critical_event_at);

-- Índice único por empleado en cada tenant/branch
CREATE UNIQUE INDEX IF NOT EXISTS idx_guardian_unique_employee
ON guardian_employee_scores(tenant_id, branch_id, employee_id);

-- Índice compuesto para consultas de dashboard
CREATE INDEX IF NOT EXISTS idx_guardian_tenant_branch_score
ON guardian_employee_scores(tenant_id, branch_id, score DESC);

-- Trigger para actualizar last_updated_at
CREATE OR REPLACE FUNCTION update_guardian_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.last_updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_guardian_updated_at ON guardian_employee_scores;

CREATE TRIGGER trigger_update_guardian_updated_at
BEFORE UPDATE ON guardian_employee_scores
FOR EACH ROW
EXECUTE FUNCTION update_guardian_updated_at();

-- Trigger para calcular score_band automáticamente
CREATE OR REPLACE FUNCTION calculate_guardian_score_band()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.score < 30 THEN
    NEW.score_band = 'verde';
  ELSIF NEW.score < 60 THEN
    NEW.score_band = 'amarillo';
  ELSIF NEW.score < 90 THEN
    NEW.score_band = 'naranja';
  ELSE
    NEW.score_band = 'rojo';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_calculate_guardian_score_band ON guardian_employee_scores;

CREATE TRIGGER trigger_calculate_guardian_score_band
BEFORE INSERT OR UPDATE OF score ON guardian_employee_scores
FOR EACH ROW
EXECUTE FUNCTION calculate_guardian_score_band();

-- Vista completa para la app móvil
CREATE OR REPLACE VIEW v_guardian_scores_complete AS
SELECT
  g.id,
  g.tenant_id,
  g.branch_id,
  b.name as branch_name,
  b.branch_code,
  g.employee_id,
  e.full_name as employee_name,
  e.username as employee_username,
  g.score,
  g.critical_events,
  g.high_events,
  g.moderate_events,
  g.low_events,
  g.informative_events,
  g.critical_events + g.high_events + g.moderate_events + g.low_events + g.informative_events as total_events,
  g.last_points_applied,
  g.last_event_at,
  g.last_critical_event_at,
  g.last_high_or_critical_event_at,
  g.last_decay_applied,
  g.last_reset_at,
  g.score_band,
  CASE g.score_band
    WHEN 'verde' THEN 1
    WHEN 'amarillo' THEN 2
    WHEN 'naranja' THEN 3
    WHEN 'rojo' THEN 4
    ELSE 0
  END as risk_level,
  g.created_at,
  g.last_updated_at,
  g.synced,
  g.synced_at
FROM guardian_employee_scores g
LEFT JOIN branches b ON g.branch_id = b.id
LEFT JOIN employees e ON g.employee_id = e.id;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- NOTAS:
-- - score: Puntuación acumulada del empleado
-- - score_band: Banda de riesgo calculada automáticamente
--   * verde: 0-29 puntos (bajo riesgo)
--   * amarillo: 30-59 puntos (riesgo moderado)
--   * naranja: 60-89 puntos (riesgo alto)
--   * rojo: 90+ puntos (riesgo crítico)
-- - critical_events: Eventos críticos (peso alto)
-- - high_events: Eventos de alta prioridad
-- - moderate_events: Eventos moderados
-- - low_events: Eventos de baja prioridad
-- - informative_events: Eventos informativos (sin peso)
-- - last_decay_applied: Última vez que se aplicó decaimiento de puntos
-- ═══════════════════════════════════════════════════════════════════════════
