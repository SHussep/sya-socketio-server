-- ============================================================================
-- MIGRACIÓN 003B: ACTUALIZAR TABLA SHIFTS EXISTENTE
-- ============================================================================
-- Agregar columnas faltantes y ajustar nombres para coincidir con el modelo
-- ============================================================================

-- 1. Agregar transaction_counter si no existe
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS transaction_counter INTEGER NOT NULL DEFAULT 0;

-- 2. Cambiar is_active por is_cash_cut_open (más descriptivo)
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS is_cash_cut_open BOOLEAN NOT NULL DEFAULT true;

-- 3. Renombrar initial_cash a initial_amount
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='shifts' AND column_name='initial_cash') THEN
        ALTER TABLE shifts RENAME COLUMN initial_cash TO initial_amount;
    END IF;
END $$;

-- 4. Renombrar final_cash a final_amount
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='shifts' AND column_name='final_cash') THEN
        ALTER TABLE shifts RENAME COLUMN final_cash TO final_amount;
    END IF;
END $$;

-- 5. Agregar updated_at si no existe
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- 6. Crear índices faltantes
CREATE INDEX IF NOT EXISTS idx_shifts_tenant ON shifts(tenant_id);
CREATE INDEX IF NOT EXISTS idx_shifts_branch ON shifts(branch_id);
CREATE INDEX IF NOT EXISTS idx_shifts_employee ON shifts(employee_id);
CREATE INDEX IF NOT EXISTS idx_shifts_start_time ON shifts(start_time DESC);
CREATE INDEX IF NOT EXISTS idx_shifts_status ON shifts(is_cash_cut_open);

-- 7. Crear trigger para updated_at si no existe
CREATE OR REPLACE FUNCTION update_shifts_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_shifts_updated_at ON shifts;
CREATE TRIGGER trigger_shifts_updated_at
    BEFORE UPDATE ON shifts
    FOR EACH ROW
    EXECUTE FUNCTION update_shifts_updated_at();

-- 8. Si is_active aún existe y hay datos, migrarlos a is_cash_cut_open
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='shifts' AND column_name='is_active') THEN
        UPDATE shifts SET is_cash_cut_open = is_active WHERE is_active IS NOT NULL;
    END IF;
END $$;

-- 9. Agregar comentarios descriptivos
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
