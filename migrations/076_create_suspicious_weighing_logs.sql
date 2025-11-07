-- =====================================================
-- Migration: 076_create_suspicious_weighing_logs.sql
-- Descripción: Eliminar tabla vieja y crear nueva con nombre consistente y campos offline-first
-- =====================================================

-- 1. ELIMINAR TABLA VIEJA (suspicious_weighing_events - nombre inconsistente)
DROP TABLE IF EXISTS suspicious_weighing_events CASCADE;

-- 2. CREAR NUEVA TABLA (suspicious_weighing_logs - mismo nombre que Desktop)
CREATE TABLE suspicious_weighing_logs (
    -- Primary Key
    id SERIAL PRIMARY KEY,

    -- Foreign Keys
    tenant_id INTEGER NOT NULL,
    branch_id INTEGER NOT NULL,
    shift_id INTEGER REFERENCES shifts(id) ON DELETE SET NULL,
    employee_id INTEGER NOT NULL,

    -- Event Data
    timestamp TIMESTAMPTZ NOT NULL,
    event_type VARCHAR(100) NOT NULL,
    weight_detected DECIMAL(10,3),
    details TEXT,

    -- Analysis Fields
    severity VARCHAR(50), -- Low, Medium, High, Critical
    suspicion_level VARCHAR(50),
    scenario_code VARCHAR(100),
    risk_score INTEGER,
    points_assigned INTEGER,
    employee_score_after_event DECIMAL(10,2),
    employee_score_band VARCHAR(50),
    page_context VARCHAR(100),
    trust_score DECIMAL(10,2),
    additional_data_json TEXT,

    -- Review Fields
    was_reviewed BOOLEAN DEFAULT FALSE,
    review_notes TEXT,
    reviewed_at TIMESTAMPTZ,
    reviewed_by_employee_id INTEGER,

    -- Pattern Metadata
    similar_events_in_session INTEGER,
    cycle_duration_seconds DECIMAL(10,2),
    max_weight_in_cycle DECIMAL(10,3),
    discrepancy_amount DECIMAL(10,3),

    -- Correlation
    related_product_id INTEGER,
    related_sale_id INTEGER,

    -- ============================================================================
    -- OFFLINE-FIRST FIELDS - Idempotent Sync
    -- ============================================================================
    global_id VARCHAR(36) UNIQUE, -- UUID for idempotent sync
    terminal_id VARCHAR(36), -- Device UUID
    local_op_seq BIGINT, -- Local operation sequence
    created_local_utc VARCHAR(50), -- ISO 8601 timestamp
    device_event_raw BIGINT, -- .NET ticks

    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. CREAR ÍNDICES
CREATE INDEX idx_suspicious_weighing_logs_tenant_branch ON suspicious_weighing_logs(tenant_id, branch_id);
CREATE INDEX idx_suspicious_weighing_logs_shift ON suspicious_weighing_logs(shift_id);
CREATE INDEX idx_suspicious_weighing_logs_employee ON suspicious_weighing_logs(employee_id);
CREATE INDEX idx_suspicious_weighing_logs_timestamp ON suspicious_weighing_logs(timestamp);
CREATE INDEX idx_suspicious_weighing_logs_severity ON suspicious_weighing_logs(severity);
CREATE UNIQUE INDEX idx_suspicious_weighing_logs_global_id ON suspicious_weighing_logs(global_id) WHERE global_id IS NOT NULL;

-- 4. COMENTARIOS
COMMENT ON TABLE suspicious_weighing_logs IS 'Guardian system: Logs de pesajes sospechosos detectados por la báscula en tiempo real';
COMMENT ON COLUMN suspicious_weighing_logs.global_id IS 'UUID global único para sincronización idempotente desde Desktop';
COMMENT ON COLUMN suspicious_weighing_logs.terminal_id IS 'UUID del dispositivo que creó este log';
COMMENT ON COLUMN suspicious_weighing_logs.scenario_code IS 'Código del escenario detectado (ej: WEIGHT_WITHOUT_SALE, RAPID_CYCLES)';
COMMENT ON COLUMN suspicious_weighing_logs.risk_score IS 'Puntuación de riesgo 0-100';

-- 5. VERIFICACIÓN
DO $$
BEGIN
    IF EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'suspicious_weighing_logs'
    ) THEN
        RAISE NOTICE '✅ Tabla suspicious_weighing_logs creada exitosamente';
    ELSE
        RAISE EXCEPTION '❌ Error: Tabla suspicious_weighing_logs no fue creada';
    END IF;

    IF NOT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'suspicious_weighing_events'
    ) THEN
        RAISE NOTICE '✅ Tabla vieja suspicious_weighing_events eliminada exitosamente';
    ELSE
        RAISE EXCEPTION '❌ Error: Tabla vieja suspicious_weighing_events aún existe';
    END IF;

    IF EXISTS (
        SELECT FROM information_schema.columns
        WHERE table_name = 'suspicious_weighing_logs' AND column_name = 'global_id'
    ) THEN
        RAISE NOTICE '✅ Columna global_id existe en suspicious_weighing_logs';
    ELSE
        RAISE EXCEPTION '❌ Error: Columna global_id no existe';
    END IF;
END $$;
