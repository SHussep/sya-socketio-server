-- ═══════════════════════════════════════════════════════════════════════════
-- MIGRACIÓN: Logs de Modo Preparación
-- ═══════════════════════════════════════════════════════════════════════════
-- El Modo Preparación permite pesar productos sin que el Guardian genere alertas.
-- Esta tabla registra cada activación/desactivación para auditoría y prevención
-- de abusos, ya que este modo es vulnerable a mal uso.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Crear tabla preparation_mode_logs
CREATE TABLE IF NOT EXISTS preparation_mode_logs (
    id SERIAL PRIMARY KEY,

    -- Multi-tenant
    tenant_id INTEGER NOT NULL REFERENCES tenants(id),
    branch_id INTEGER NOT NULL REFERENCES branches(id),

    -- Referencias
    shift_id INTEGER REFERENCES shifts(id),
    operator_employee_id INTEGER NOT NULL REFERENCES employees(id),
    authorized_by_employee_id INTEGER REFERENCES employees(id),

    -- Tiempos de activación
    activated_at TIMESTAMP WITH TIME ZONE NOT NULL,
    deactivated_at TIMESTAMP WITH TIME ZONE,
    duration_seconds DECIMAL(10,2),

    -- Razón y Notas
    reason VARCHAR(500),
    notes TEXT,

    -- Revisión administrativa
    was_reviewed BOOLEAN DEFAULT FALSE,
    review_notes TEXT,
    reviewed_at TIMESTAMP WITH TIME ZONE,
    reviewed_by_employee_id INTEGER REFERENCES employees(id),

    -- Estado: 'active', 'completed', 'force_closed'
    status VARCHAR(50) NOT NULL DEFAULT 'active',

    -- Severidad calculada por duración
    -- Low: < 3 min, Medium: 3-10 min, High: 10-30 min, Critical: > 30 min
    severity VARCHAR(50) DEFAULT 'Low',

    -- Sincronización offline-first
    global_id VARCHAR(36) NOT NULL UNIQUE,
    terminal_id VARCHAR(50),
    local_op_seq INTEGER DEFAULT 0,
    device_event_raw BIGINT DEFAULT 0,
    created_local_utc TIMESTAMP WITH TIME ZONE,

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 2. Índices para rendimiento
CREATE INDEX IF NOT EXISTS idx_prep_mode_logs_tenant ON preparation_mode_logs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_prep_mode_logs_branch ON preparation_mode_logs(branch_id);
CREATE INDEX IF NOT EXISTS idx_prep_mode_logs_tenant_branch ON preparation_mode_logs(tenant_id, branch_id);
CREATE INDEX IF NOT EXISTS idx_prep_mode_logs_shift ON preparation_mode_logs(shift_id);
CREATE INDEX IF NOT EXISTS idx_prep_mode_logs_operator ON preparation_mode_logs(operator_employee_id);
CREATE INDEX IF NOT EXISTS idx_prep_mode_logs_authorized_by ON preparation_mode_logs(authorized_by_employee_id);
CREATE INDEX IF NOT EXISTS idx_prep_mode_logs_activated ON preparation_mode_logs(activated_at DESC);
CREATE INDEX IF NOT EXISTS idx_prep_mode_logs_status ON preparation_mode_logs(status);
CREATE INDEX IF NOT EXISTS idx_prep_mode_logs_severity ON preparation_mode_logs(severity);
CREATE INDEX IF NOT EXISTS idx_prep_mode_logs_reviewed ON preparation_mode_logs(was_reviewed) WHERE was_reviewed = false;
CREATE INDEX IF NOT EXISTS idx_prep_mode_logs_global_id ON preparation_mode_logs(global_id);

-- 3. Trigger para actualizar updated_at
CREATE OR REPLACE FUNCTION update_preparation_mode_logs_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_prep_mode_logs_updated_at ON preparation_mode_logs;
CREATE TRIGGER trigger_prep_mode_logs_updated_at
    BEFORE UPDATE ON preparation_mode_logs
    FOR EACH ROW
    EXECUTE FUNCTION update_preparation_mode_logs_updated_at();

-- 4. Trigger para calcular severidad basada en duración
CREATE OR REPLACE FUNCTION calculate_prep_mode_severity()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.duration_seconds IS NOT NULL THEN
        IF NEW.duration_seconds > 1800 THEN
            NEW.severity = 'Critical';
        ELSIF NEW.duration_seconds > 600 THEN
            NEW.severity = 'High';
        ELSIF NEW.duration_seconds > 180 THEN
            NEW.severity = 'Medium';
        ELSE
            NEW.severity = 'Low';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_prep_mode_severity ON preparation_mode_logs;
CREATE TRIGGER trigger_prep_mode_severity
    BEFORE INSERT OR UPDATE ON preparation_mode_logs
    FOR EACH ROW
    EXECUTE FUNCTION calculate_prep_mode_severity();

-- 5. Vista para estadísticas de uso del modo preparación por empleado
CREATE OR REPLACE VIEW preparation_mode_stats AS
SELECT
    tenant_id,
    branch_id,
    operator_employee_id,
    COUNT(*) as total_activations,
    COALESCE(SUM(duration_seconds), 0) as total_duration_seconds,
    AVG(duration_seconds) as avg_duration_seconds,
    MAX(duration_seconds) as max_duration_seconds,
    COUNT(*) FILTER (WHERE severity = 'Critical') as critical_count,
    COUNT(*) FILTER (WHERE severity = 'High') as high_count,
    COUNT(*) FILTER (WHERE severity = 'Medium') as medium_count,
    COUNT(*) FILTER (WHERE severity = 'Low') as low_count,
    COUNT(*) FILTER (WHERE status = 'active') as active_sessions,
    COUNT(*) FILTER (WHERE was_reviewed = false AND status = 'completed') as pending_review,
    MAX(activated_at) as last_activation
FROM preparation_mode_logs
WHERE status != 'force_closed'
GROUP BY tenant_id, branch_id, operator_employee_id;

-- 6. Vista para resumen diario por sucursal
CREATE OR REPLACE VIEW preparation_mode_daily_summary AS
SELECT
    tenant_id,
    branch_id,
    DATE(activated_at AT TIME ZONE 'UTC') as date,
    COUNT(*) as activations_count,
    COALESCE(SUM(duration_seconds), 0) as total_duration_seconds,
    COUNT(DISTINCT operator_employee_id) as unique_operators,
    COUNT(*) FILTER (WHERE severity IN ('Critical', 'High')) as high_severity_count
FROM preparation_mode_logs
WHERE status = 'completed'
GROUP BY tenant_id, branch_id, DATE(activated_at AT TIME ZONE 'UTC');

-- 7. Comentarios de documentación
COMMENT ON TABLE preparation_mode_logs IS 'Registro de activaciones del Modo Preparación - permite auditar uso de función vulnerable';
COMMENT ON COLUMN preparation_mode_logs.operator_employee_id IS 'Empleado que estaba operando el sistema cuando se activó';
COMMENT ON COLUMN preparation_mode_logs.authorized_by_employee_id IS 'Administrador que autorizó la activación (puede ser diferente al operador)';
COMMENT ON COLUMN preparation_mode_logs.duration_seconds IS 'Duración total en segundos - calculada al desactivar';
COMMENT ON COLUMN preparation_mode_logs.severity IS 'Severidad basada en duración: Low (<3m), Medium (3-10m), High (10-30m), Critical (>30m)';
COMMENT ON COLUMN preparation_mode_logs.status IS 'Estado: active (en curso), completed (desactivado normal), force_closed (cerrado por sistema)';
