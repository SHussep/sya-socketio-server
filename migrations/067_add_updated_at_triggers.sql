-- =====================================================
-- Migration: 067_add_updated_at_triggers.sql
-- Descripción: Agregar triggers para updated_at automático en tablas transaccionales
-- =====================================================

-- ✅ Crear función para actualizar updated_at
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ✅ Trigger para ventas
DROP TRIGGER IF EXISTS trg_ventas_updated_at ON ventas;
CREATE TRIGGER trg_ventas_updated_at
    BEFORE UPDATE ON ventas
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

-- ✅ Trigger para ventas_detalle
DROP TRIGGER IF EXISTS trg_ventas_detalle_updated_at ON ventas_detalle;
CREATE TRIGGER trg_ventas_detalle_updated_at
    BEFORE UPDATE ON ventas_detalle
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

-- ✅ Trigger para repartidor_assignments
DROP TRIGGER IF EXISTS trg_repartidor_assignments_updated_at ON repartidor_assignments;
CREATE TRIGGER trg_repartidor_assignments_updated_at
    BEFORE UPDATE ON repartidor_assignments
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

-- ✅ Trigger para expenses
DROP TRIGGER IF EXISTS trg_expenses_updated_at ON expenses;
CREATE TRIGGER trg_expenses_updated_at
    BEFORE UPDATE ON expenses
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

-- ✅ Trigger para deposits
DROP TRIGGER IF EXISTS trg_deposits_updated_at ON deposits;
CREATE TRIGGER trg_deposits_updated_at
    BEFORE UPDATE ON deposits
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

-- ✅ Trigger para withdrawals
DROP TRIGGER IF EXISTS trg_withdrawals_updated_at ON withdrawals;
CREATE TRIGGER trg_withdrawals_updated_at
    BEFORE UPDATE ON withdrawals
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

-- ✅ Trigger para cash_cuts
DROP TRIGGER IF EXISTS trg_cash_cuts_updated_at ON cash_cuts;
CREATE TRIGGER trg_cash_cuts_updated_at
    BEFORE UPDATE ON cash_cuts
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

COMMENT ON FUNCTION set_updated_at() IS 'Actualiza automáticamente updated_at a NOW() en cada UPDATE';
