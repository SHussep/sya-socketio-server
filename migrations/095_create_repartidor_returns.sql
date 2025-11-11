-- Migration 095: Create repartidor_returns table
-- ==============================================================================
-- OBJETIVO: Crear tabla para historial detallado de devoluciones por repartidor
-- Cumple 3NF: Evita redundancia con repartidor_assignments
-- Cada registro = UNA devolución específica con fecha, cantidad y razón
-- Los totales se calculan mediante SUM() en queries
-- ==============================================================================

CREATE TABLE IF NOT EXISTS repartidor_returns (
    id SERIAL PRIMARY KEY,

    -- UUID para idempotencia (offline-first)
    global_id UUID UNIQUE NOT NULL,

    -- Relaciones y trazabilidad
    assignment_id INTEGER NOT NULL REFERENCES repartidor_assignments(id) ON DELETE CASCADE,
    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
    registered_by_employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    shift_id INTEGER REFERENCES shifts(id) ON DELETE SET NULL,

    -- Datos de la devolución
    quantity NUMERIC(10,2) NOT NULL CHECK (quantity > 0),
    unit_price NUMERIC(10,2) NOT NULL,
    amount NUMERIC(10,2) NOT NULL,  -- Calculado: quantity * unit_price

    -- Fecha y origen
    return_date TIMESTAMP WITH TIME ZONE NOT NULL,
    source VARCHAR(20) NOT NULL CHECK (source IN ('desktop', 'mobile')),
    notes TEXT,

    -- Offline-first fields (UUID, terminal, secuencia)
    terminal_id UUID NOT NULL,
    local_op_seq INTEGER NOT NULL,
    created_local_utc TIMESTAMP WITH TIME ZONE NOT NULL,
    device_event_raw BIGINT,

    -- Sincronización
    synced BOOLEAN NOT NULL DEFAULT true,  -- En backend siempre true
    synced_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    needs_update BOOLEAN DEFAULT false,
    last_modified_local_utc TIMESTAMP WITH TIME ZONE,

    -- Auditoría
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Índices para performance
CREATE INDEX IF NOT EXISTS idx_repartidor_returns_global_id ON repartidor_returns(global_id);
CREATE INDEX IF NOT EXISTS idx_repartidor_returns_assignment ON repartidor_returns(assignment_id);
CREATE INDEX IF NOT EXISTS idx_repartidor_returns_employee ON repartidor_returns(employee_id);
CREATE INDEX IF NOT EXISTS idx_repartidor_returns_tenant ON repartidor_returns(tenant_id);
CREATE INDEX IF NOT EXISTS idx_repartidor_returns_branch ON repartidor_returns(branch_id);
CREATE INDEX IF NOT EXISTS idx_repartidor_returns_shift ON repartidor_returns(shift_id);
CREATE INDEX IF NOT EXISTS idx_repartidor_returns_return_date ON repartidor_returns(return_date);
CREATE INDEX IF NOT EXISTS idx_repartidor_returns_source ON repartidor_returns(source);
CREATE INDEX IF NOT EXISTS idx_repartidor_returns_synced ON repartidor_returns(synced);
CREATE INDEX IF NOT EXISTS idx_repartidor_returns_needs_update ON repartidor_returns(needs_update);

-- Constraint: global_id debe ser único por terminal
CREATE UNIQUE INDEX IF NOT EXISTS unique_repartidor_returns_global_terminal
    ON repartidor_returns(global_id, terminal_id);

-- Trigger para actualizar updated_at automáticamente
CREATE OR REPLACE FUNCTION update_repartidor_returns_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_repartidor_returns_updated_at ON repartidor_returns;
CREATE TRIGGER trigger_repartidor_returns_updated_at
    BEFORE UPDATE ON repartidor_returns
    FOR EACH ROW
    EXECUTE FUNCTION update_repartidor_returns_updated_at();

-- Comentarios de documentación
COMMENT ON TABLE repartidor_returns IS 'Historial detallado de devoluciones por repartidor (evita redundancia con assignments)';
COMMENT ON COLUMN repartidor_returns.global_id IS 'UUID único para idempotencia (offline-first)';
COMMENT ON COLUMN repartidor_returns.assignment_id IS 'FK a repartidor_assignments (N:1 - múltiples devoluciones por asignación)';
COMMENT ON COLUMN repartidor_returns.employee_id IS 'Repartidor que devuelve';
COMMENT ON COLUMN repartidor_returns.registered_by_employee_id IS 'Quién registró: repartidor (mobile) o cajero (desktop)';
COMMENT ON COLUMN repartidor_returns.quantity IS 'Cantidad devuelta en ESTA devolución específica';
COMMENT ON COLUMN repartidor_returns.unit_price IS 'Precio unitario al momento de la devolución';
COMMENT ON COLUMN repartidor_returns.amount IS 'Monto de esta devolución (quantity * unit_price)';
COMMENT ON COLUMN repartidor_returns.return_date IS 'Cuándo se devolvió (timestamp con timezone)';
COMMENT ON COLUMN repartidor_returns.source IS 'desktop (cajero) | mobile (app repartidor)';
COMMENT ON COLUMN repartidor_returns.notes IS 'Razón de la devolución';
COMMENT ON COLUMN repartidor_returns.needs_update IS 'TRUE si hay cambios pendientes de sync';
