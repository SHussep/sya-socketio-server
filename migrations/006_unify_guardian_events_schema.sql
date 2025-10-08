-- ============================================================================
-- MIGRACIÓN: Unificar Guardian Events con estructura SQLite Desktop
-- Versión: 1.1.0
-- Fecha: 2025-10-08
-- Descripción: Sincroniza estructura de guardian_events con SuspiciousWeighingLogs
--              para mantener compatibilidad total con el sistema de báscula
-- ============================================================================

BEGIN;

-- Eliminar tabla antigua si existe
DROP TABLE IF EXISTS guardian_events CASCADE;

-- ============================================================================
-- TABLA: guardian_events (ESTRUCTURA UNIFICADA CON SQLITE)
-- ============================================================================

CREATE TABLE guardian_events (
    -- Campos base (PostgreSQL multi-tenant)
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,

    -- Campos compatibles con SuspiciousWeighingLog (SQLite)
    employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    shift_id INTEGER, -- ID del turno local (no FK, es referencia al turno SQLite)
    timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- Información del evento
    event_type VARCHAR(100) NOT NULL,
    weight_detected DECIMAL(10, 3), -- WeightDetected (kg con 3 decimales)
    details TEXT,

    -- Niveles de severidad y riesgo
    severity VARCHAR(20) DEFAULT 'Medium', -- Low, Medium, High, Critical
    suspicion_level VARCHAR(50),
    scenario_code VARCHAR(50),
    risk_score INTEGER DEFAULT 0,
    points_assigned INTEGER DEFAULT 0,

    -- Score del empleado al momento del evento
    employee_score_after_event DECIMAL(10, 2) DEFAULT 0,
    employee_score_band VARCHAR(50),

    -- Contexto de la aplicación
    page_context VARCHAR(100), -- En qué página ocurrió (POS, Inventory, etc)
    trust_score DECIMAL(10, 2), -- Score de confianza del empleado

    -- Metadata adicional (JSON)
    additional_data_json TEXT,

    -- Estado de revisión
    was_reviewed BOOLEAN DEFAULT false,
    review_notes TEXT,
    reviewed_at TIMESTAMP,
    reviewed_by_employee_id INTEGER REFERENCES employees(id),

    -- Metadata para análisis de patrones
    similar_events_in_session INTEGER DEFAULT 0,
    cycle_duration_seconds DECIMAL(10, 2),
    max_weight_in_cycle DECIMAL(10, 3),
    discrepancy_amount DECIMAL(10, 3),

    -- Correlación con otras entidades
    related_product_id INTEGER, -- ID del producto local (no FK)
    related_sale_id INTEGER, -- ID de la venta local (no FK)

    -- Campos específicos para desconexión de báscula
    scale_id VARCHAR(100),
    disconnection_start TIMESTAMP,
    disconnection_end TIMESTAMP,
    duration_minutes DECIMAL(10, 2),

    -- Control de sincronización
    synced_from_local BOOLEAN DEFAULT false, -- Si viene de Desktop
    local_id INTEGER, -- ID del registro en SQLite local

    -- Campos de auditoría
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- ÍNDICES PARA RENDIMIENTO
-- ============================================================================

CREATE INDEX idx_guardian_events_tenant ON guardian_events(tenant_id);
CREATE INDEX idx_guardian_events_branch ON guardian_events(branch_id);
CREATE INDEX idx_guardian_events_employee ON guardian_events(employee_id);
CREATE INDEX idx_guardian_events_timestamp ON guardian_events(timestamp DESC);
CREATE INDEX idx_guardian_events_event_type ON guardian_events(event_type);
CREATE INDEX idx_guardian_events_severity ON guardian_events(severity);
CREATE INDEX idx_guardian_events_reviewed ON guardian_events(was_reviewed) WHERE was_reviewed = false;
CREATE INDEX idx_guardian_events_scenario ON guardian_events(scenario_code) WHERE scenario_code IS NOT NULL;

-- Índice compuesto para queries del dashboard móvil
CREATE INDEX idx_guardian_events_dashboard ON guardian_events(tenant_id, branch_id, timestamp DESC);

-- ============================================================================
-- TABLA: guardian_employee_scores (SCORES DE EMPLEADOS)
-- ============================================================================

CREATE TABLE IF NOT EXISTS guardian_employee_scores (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,

    -- Scores
    score DECIMAL(10, 2) DEFAULT 0,
    score_band VARCHAR(50), -- Excellent, Good, Average, Poor, Critical

    -- Contadores por severidad
    critical_events INTEGER DEFAULT 0,
    high_events INTEGER DEFAULT 0,
    moderate_events INTEGER DEFAULT 0,
    low_events INTEGER DEFAULT 0,
    informative_events INTEGER DEFAULT 0,

    -- Historial
    last_points_applied DECIMAL(10, 2),
    last_event_at TIMESTAMP,
    last_critical_event_at TIMESTAMP,
    last_high_or_critical_event_at TIMESTAMP,

    -- Decay (degradación del score con el tiempo)
    last_decay_applied TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_reset_at TIMESTAMP,

    -- Auditoría
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    UNIQUE(tenant_id, branch_id, employee_id)
);

CREATE INDEX idx_guardian_scores_tenant ON guardian_employee_scores(tenant_id);
CREATE INDEX idx_guardian_scores_branch ON guardian_employee_scores(branch_id);
CREATE INDEX idx_guardian_scores_employee ON guardian_employee_scores(employee_id);
CREATE INDEX idx_guardian_scores_band ON guardian_employee_scores(score_band);

-- ============================================================================
-- TABLA: scale_disconnection_logs (DESCONEXIONES DE BÁSCULA)
-- ============================================================================

CREATE TABLE IF NOT EXISTS scale_disconnection_logs (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,

    scale_id VARCHAR(100) NOT NULL,
    start_time TIMESTAMP NOT NULL,
    end_time TIMESTAMP,
    duration_minutes DECIMAL(10, 2),

    -- Contexto
    shift_id INTEGER,
    was_intentional BOOLEAN DEFAULT false, -- Si fue apagado intencionalmente
    notes TEXT,

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_scale_disconnections_tenant ON scale_disconnection_logs(tenant_id);
CREATE INDEX idx_scale_disconnections_branch ON scale_disconnection_logs(branch_id);
CREATE INDEX idx_scale_disconnections_scale ON scale_disconnection_logs(scale_id);
CREATE INDEX idx_scale_disconnections_time ON scale_disconnection_logs(start_time DESC);

-- ============================================================================
-- TRIGGER: Actualizar updated_at automáticamente
-- ============================================================================

CREATE TRIGGER update_guardian_events_updated_at
BEFORE UPDATE ON guardian_events
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_guardian_scores_updated_at
BEFORE UPDATE ON guardian_employee_scores
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- DATOS DE PRUEBA (OPCIONAL - COMENTAR EN PRODUCCIÓN)
-- ============================================================================

-- Insertar evento de ejemplo si existe tenant_id = 1 y branch_id = 1
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM tenants WHERE id = 1) AND EXISTS (SELECT 1 FROM branches WHERE id = 1) THEN
        INSERT INTO guardian_events (
            tenant_id, branch_id, employee_id, event_type,
            weight_detected, details, severity, scenario_code, risk_score
        ) VALUES (
            1, 1, NULL, 'scale_suspicious_weighing',
            2.500, 'Peso detectado no registrado en venta', 'High', 'UNREGISTERED_WEIGHT', 75
        );
    END IF;
END $$;

COMMIT;

-- ============================================================================
-- VERIFICACIÓN
-- ============================================================================

-- Verificar estructura de guardian_events
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'guardian_events'
ORDER BY ordinal_position;

-- Contar registros
SELECT COUNT(*) as total_guardian_events FROM guardian_events;
