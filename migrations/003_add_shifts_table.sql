-- ============================================================================
-- MIGRACIÓN 003: TABLA SHIFTS (TURNOS/CORTES DE CAJA)
-- ============================================================================
-- Esta tabla almacena los turnos de trabajo de cada empleado en cada sucursal.
-- Permite rastrear:
-- - Hora de inicio y fin de sesión
-- - Monto inicial y final de caja
-- - Cortes de caja (arqueos)
-- - Ventas, gastos y compras realizadas durante el turno
-- ============================================================================

CREATE TABLE IF NOT EXISTS shifts (
    id SERIAL PRIMARY KEY,

    -- Relaciones multi-tenant
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,

    -- Información del turno
    start_time TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    end_time TIMESTAMP, -- NULL mientras el turno está abierto

    -- Montos de caja
    initial_amount DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    final_amount DECIMAL(10, 2), -- NULL hasta que se cierra el turno

    -- Contadores
    transaction_counter INTEGER NOT NULL DEFAULT 0, -- Número de tickets vendidos en el turno

    -- Estado
    is_cash_cut_open BOOLEAN NOT NULL DEFAULT true, -- false cuando se cierra el turno

    -- Auditoría
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- Índices para búsquedas rápidas
    CONSTRAINT idx_shifts_tenant_branch UNIQUE (tenant_id, branch_id, employee_id, start_time)
);

-- Índices para mejorar rendimiento
CREATE INDEX IF NOT EXISTS idx_shifts_tenant ON shifts(tenant_id);
CREATE INDEX IF NOT EXISTS idx_shifts_branch ON shifts(branch_id);
CREATE INDEX IF NOT EXISTS idx_shifts_employee ON shifts(employee_id);
CREATE INDEX IF NOT EXISTS idx_shifts_start_time ON shifts(start_time DESC);
CREATE INDEX IF NOT EXISTS idx_shifts_status ON shifts(is_cash_cut_open);

-- Trigger para actualizar updated_at automáticamente
CREATE OR REPLACE FUNCTION update_shifts_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_shifts_updated_at
    BEFORE UPDATE ON shifts
    FOR EACH ROW
    EXECUTE FUNCTION update_shifts_updated_at();

-- ============================================================================
-- COMENTARIOS DESCRIPTIVOS
-- ============================================================================

COMMENT ON TABLE shifts IS 'Registra los turnos de trabajo de empleados con apertura/cierre de caja';
COMMENT ON COLUMN shifts.tenant_id IS 'ID del tenant (empresa/negocio)';
COMMENT ON COLUMN shifts.branch_id IS 'ID de la sucursal donde se trabaja';
COMMENT ON COLUMN shifts.employee_id IS 'ID del empleado que abre el turno';
COMMENT ON COLUMN shifts.start_time IS 'Fecha y hora de inicio de sesión';
COMMENT ON COLUMN shifts.end_time IS 'Fecha y hora de cierre de sesión (NULL si está abierto)';
COMMENT ON COLUMN shifts.initial_amount IS 'Efectivo inicial en caja al abrir turno';
COMMENT ON COLUMN shifts.final_amount IS 'Efectivo final en caja al cerrar turno';
COMMENT ON COLUMN shifts.transaction_counter IS 'Contador de tickets vendidos durante el turno';
COMMENT ON COLUMN shifts.is_cash_cut_open IS 'true = turno abierto, false = turno cerrado';
