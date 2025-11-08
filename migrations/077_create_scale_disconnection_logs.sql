-- =====================================================
-- Migration: 077_create_scale_disconnection_logs.sql
-- Descripción: Crear tabla para eventos de desconexión de báscula con campos offline-first
-- Fecha: 2025-11-07
-- =====================================================

-- 1. CREAR TABLA
CREATE TABLE IF NOT EXISTS scale_disconnection_logs (
    -- Primary Key
    id SERIAL PRIMARY KEY,

    -- Foreign Keys
    tenant_id INTEGER NOT NULL,
    branch_id INTEGER NOT NULL,
    shift_id INTEGER REFERENCES shifts(id) ON DELETE SET NULL,
    employee_id INTEGER NOT NULL,

    -- Event Data
    disconnected_at TIMESTAMPTZ NOT NULL,
    reconnected_at TIMESTAMPTZ,
    duration_minutes DECIMAL(10,2),
    status VARCHAR(50) NOT NULL, -- Disconnected, Reconnected
    reason VARCHAR(100), -- Manual, PowerFailure, CableDisconnected, Unknown
    notes TEXT,

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

-- 2. CREAR ÍNDICES
CREATE INDEX idx_scale_disconnection_logs_tenant_branch ON scale_disconnection_logs(tenant_id, branch_id);
CREATE INDEX idx_scale_disconnection_logs_shift ON scale_disconnection_logs(shift_id);
CREATE INDEX idx_scale_disconnection_logs_employee ON scale_disconnection_logs(employee_id);
CREATE INDEX idx_scale_disconnection_logs_disconnected_at ON scale_disconnection_logs(disconnected_at);
CREATE INDEX idx_scale_disconnection_logs_status ON scale_disconnection_logs(status);
CREATE UNIQUE INDEX idx_scale_disconnection_logs_global_id ON scale_disconnection_logs(global_id) WHERE global_id IS NOT NULL;

-- 3. COMENTARIOS
COMMENT ON TABLE scale_disconnection_logs IS 'Registro de eventos de desconexión de báscula - tracking de disponibilidad de hardware';
COMMENT ON COLUMN scale_disconnection_logs.global_id IS 'UUID global único para sincronización idempotente desde Desktop';
COMMENT ON COLUMN scale_disconnection_logs.terminal_id IS 'UUID del dispositivo que reportó la desconexión';
COMMENT ON COLUMN scale_disconnection_logs.disconnected_at IS 'Momento en que se detectó la desconexión';
COMMENT ON COLUMN scale_disconnection_logs.reconnected_at IS 'Momento en que se reconectó - NULL si aún está desconectada';
COMMENT ON COLUMN scale_disconnection_logs.duration_minutes IS 'Duración de la desconexión en minutos';
COMMENT ON COLUMN scale_disconnection_logs.status IS 'Estado actual: Disconnected o Reconnected';
COMMENT ON COLUMN scale_disconnection_logs.reason IS 'Razón de la desconexión: Manual, PowerFailure, CableDisconnected, Unknown';

-- 4. VERIFICACIÓN
DO $$
BEGIN
    IF EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'scale_disconnection_logs'
    ) THEN
        RAISE NOTICE '✅ Tabla scale_disconnection_logs creada exitosamente';
    ELSE
        RAISE EXCEPTION '❌ Error: Tabla scale_disconnection_logs no fue creada';
    END IF;

    IF EXISTS (
        SELECT FROM information_schema.columns
        WHERE table_name = 'scale_disconnection_logs' AND column_name = 'global_id'
    ) THEN
        RAISE NOTICE '✅ Columna global_id existe en scale_disconnection_logs';
    ELSE
        RAISE EXCEPTION '❌ Error: Columna global_id no existe';
    END IF;
END $$;
