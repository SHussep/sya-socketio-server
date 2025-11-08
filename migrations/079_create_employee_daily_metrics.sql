-- =====================================================
-- Migration: 079_create_employee_daily_metrics.sql
-- Descripción: Crear tabla de métricas diarias simplificadas por empleado
-- Fecha: 2025-11-08
-- Nota: Sistema más claro que reemplaza Guardian Scores complejos
-- =====================================================

-- ============================================================================
-- CREAR TABLA: employee_daily_metrics
-- ============================================================================
CREATE TABLE IF NOT EXISTS employee_daily_metrics (
    -- Primary Key
    id SERIAL PRIMARY KEY,

    -- Foreign Keys
    tenant_id INTEGER NOT NULL,
    branch_id INTEGER NOT NULL,
    employee_id INTEGER NOT NULL,
    date DATE NOT NULL,
    shift_id INTEGER,

    -- ============================================================================
    -- CONTADORES DE EVENTOS POR SEVERIDAD (fáciles de entender)
    -- ============================================================================
    critical_events INTEGER DEFAULT 0,
    high_events INTEGER DEFAULT 0,
    moderate_events INTEGER DEFAULT 0,
    low_events INTEGER DEFAULT 0,
    informative_events INTEGER DEFAULT 0,
    total_suspicious_events INTEGER DEFAULT 0,

    -- ============================================================================
    -- MÉTRICAS DE DESCONEXIÓN DE BÁSCULA
    -- ============================================================================
    disconnection_count INTEGER DEFAULT 0,
    disconnection_total_minutes DECIMAL(10,2) DEFAULT 0,
    disconnection_longest_minutes DECIMAL(10,2) DEFAULT 0,

    -- ============================================================================
    -- MÉTRICAS DE RENDIMIENTO
    -- ============================================================================
    total_sales INTEGER DEFAULT 0,
    clean_sales INTEGER DEFAULT 0,  -- Ventas sin eventos sospechosos
    success_rate DECIMAL(5,2) DEFAULT 100,

    -- ============================================================================
    -- ESTADO DEL DÍA (Clasificación simple)
    -- ============================================================================
    daily_status VARCHAR(20),  -- NORMAL, ATENCION, ALERTA

    -- ============================================================================
    -- TOP 3 EVENTOS MÁS FRECUENTES
    -- ============================================================================
    top_event_1_type VARCHAR(100),
    top_event_1_count INTEGER DEFAULT 0,
    top_event_2_type VARCHAR(100),
    top_event_2_count INTEGER DEFAULT 0,
    top_event_3_type VARCHAR(100),
    top_event_3_count INTEGER DEFAULT 0,

    -- ============================================================================
    -- OFFLINE-FIRST FIELDS - Idempotent Sync
    -- ============================================================================
    global_id VARCHAR(36) UNIQUE NOT NULL,
    terminal_id VARCHAR(36),
    local_op_seq BIGINT,
    created_local_utc VARCHAR(50),
    device_event_raw BIGINT,

    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- CREAR ÍNDICES
-- ============================================================================
CREATE INDEX idx_employee_daily_metrics_tenant_branch ON employee_daily_metrics(tenant_id, branch_id);
CREATE INDEX idx_employee_daily_metrics_employee ON employee_daily_metrics(employee_id);
CREATE INDEX idx_employee_daily_metrics_date ON employee_daily_metrics(date);
CREATE INDEX idx_employee_daily_metrics_status ON employee_daily_metrics(daily_status);
CREATE UNIQUE INDEX idx_employee_daily_metrics_global_id ON employee_daily_metrics(global_id);

-- Índice compuesto para consultas comunes
CREATE INDEX idx_employee_daily_metrics_employee_date ON employee_daily_metrics(employee_id, date DESC);
CREATE INDEX idx_employee_daily_metrics_date_status ON employee_daily_metrics(date, daily_status);

-- ============================================================================
-- COMENTARIOS
-- ============================================================================
COMMENT ON TABLE employee_daily_metrics IS 'Métricas diarias simplificadas por empleado - reemplaza sistema complejo de Guardian Scores';
COMMENT ON COLUMN employee_daily_metrics.critical_events IS 'Eventos críticos: Pesajes sin registro, Desconexión báscula, etc.';
COMMENT ON COLUMN employee_daily_metrics.success_rate IS 'Tasa de éxito = (CleanSales / TotalSales) * 100';
COMMENT ON COLUMN employee_daily_metrics.daily_status IS 'NORMAL (0-5 críticos), ATENCION (6-10), ALERTA (11+)';
COMMENT ON COLUMN employee_daily_metrics.global_id IS 'UUID global único para sincronización idempotente desde Desktop';

-- ============================================================================
-- VERIFICACIÓN
-- ============================================================================
DO $$
BEGIN
    IF EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'employee_daily_metrics'
    ) THEN
        RAISE NOTICE '✅ Tabla employee_daily_metrics creada exitosamente';
    ELSE
        RAISE EXCEPTION '❌ Error: Tabla employee_daily_metrics no fue creada';
    END IF;

    IF EXISTS (
        SELECT FROM information_schema.columns
        WHERE table_name = 'employee_daily_metrics' AND column_name = 'global_id'
    ) THEN
        RAISE NOTICE '✅ Columna global_id existe en employee_daily_metrics';
    ELSE
        RAISE EXCEPTION '❌ Error: Columna global_id no existe';
    END IF;

    IF EXISTS (
        SELECT FROM information_schema.columns
        WHERE table_name = 'employee_daily_metrics' AND column_name = 'daily_status'
    ) THEN
        RAISE NOTICE '✅ Columna daily_status existe en employee_daily_metrics';
    ELSE
        RAISE EXCEPTION '❌ Error: Columna daily_status no existe';
    END IF;

    -- Verificar que guardian_employee_scores_daily existe (para compatibilidad)
    IF EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'guardian_employee_scores_daily'
    ) THEN
        RAISE NOTICE '✅ Tabla guardian_employee_scores_daily existe (se poblará automáticamente)';
    ELSE
        RAISE WARNING '⚠️ Tabla guardian_employee_scores_daily no existe';
    END IF;
END $$;
