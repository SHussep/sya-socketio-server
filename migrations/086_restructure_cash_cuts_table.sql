-- =====================================================
-- Migration: 086_restructure_cash_cuts_table.sql
-- Descripción: Reestructurar cash_cuts para 1:1 con Desktop CashDrawerSession
-- =====================================================

-- PROBLEMA: cash_cuts tiene campos incompletos y no coincide con lo que Desktop envía
-- SOLUCIÓN: Agregar todos los campos que Desktop sincroniza, eliminar campos obsoletos

-- ========== AGREGAR CAMPOS FALTANTES ==========

-- Referencia al shift
ALTER TABLE cash_cuts
ADD COLUMN IF NOT EXISTS shift_id INTEGER REFERENCES shifts(id) ON DELETE SET NULL;

-- Tiempos del corte
ALTER TABLE cash_cuts
ADD COLUMN IF NOT EXISTS start_time TIMESTAMPTZ;

ALTER TABLE cash_cuts
ADD COLUMN IF NOT EXISTS end_time TIMESTAMPTZ;

-- Monto inicial
ALTER TABLE cash_cuts
ADD COLUMN IF NOT EXISTS initial_amount NUMERIC(12, 2) DEFAULT 0;

-- Ventas desglosadas por tipo de pago
ALTER TABLE cash_cuts
ADD COLUMN IF NOT EXISTS total_cash_sales NUMERIC(12, 2) DEFAULT 0;

ALTER TABLE cash_cuts
ADD COLUMN IF NOT EXISTS total_card_sales NUMERIC(12, 2) DEFAULT 0;

ALTER TABLE cash_cuts
ADD COLUMN IF NOT EXISTS total_credit_sales NUMERIC(12, 2) DEFAULT 0;

-- Pagos de crédito desglosados
ALTER TABLE cash_cuts
ADD COLUMN IF NOT EXISTS total_cash_payments NUMERIC(12, 2) DEFAULT 0;

ALTER TABLE cash_cuts
ADD COLUMN IF NOT EXISTS total_card_payments NUMERIC(12, 2) DEFAULT 0;

-- Depósitos y retiros
ALTER TABLE cash_cuts
ADD COLUMN IF NOT EXISTS total_deposits NUMERIC(12, 2) DEFAULT 0;

ALTER TABLE cash_cuts
ADD COLUMN IF NOT EXISTS total_withdrawals NUMERIC(12, 2) DEFAULT 0;

-- Efectivo esperado y contado
ALTER TABLE cash_cuts
ADD COLUMN IF NOT EXISTS expected_cash_in_drawer NUMERIC(12, 2) DEFAULT 0;

ALTER TABLE cash_cuts
ADD COLUMN IF NOT EXISTS counted_cash NUMERIC(12, 2) DEFAULT 0;

-- Eventos de seguridad (Guardian)
ALTER TABLE cash_cuts
ADD COLUMN IF NOT EXISTS unregistered_weight_events INTEGER DEFAULT 0;

ALTER TABLE cash_cuts
ADD COLUMN IF NOT EXISTS scale_connection_events INTEGER DEFAULT 0;

ALTER TABLE cash_cuts
ADD COLUMN IF NOT EXISTS cancelled_sales INTEGER DEFAULT 0;

-- Notas y estado
ALTER TABLE cash_cuts
ADD COLUMN IF NOT EXISTS notes TEXT;

ALTER TABLE cash_cuts
ADD COLUMN IF NOT EXISTS is_closed BOOLEAN DEFAULT TRUE;

-- ========== MIGRAR DATOS EXISTENTES (si los hay) ==========

-- Migrar expected_cash -> expected_cash_in_drawer
UPDATE cash_cuts
SET expected_cash_in_drawer = expected_cash
WHERE expected_cash_in_drawer = 0 AND expected_cash IS NOT NULL;

-- Migrar cash_in_drawer -> counted_cash
UPDATE cash_cuts
SET counted_cash = cash_in_drawer
WHERE counted_cash = 0 AND cash_in_drawer IS NOT NULL;

-- Migrar total_sales -> total_cash_sales (asumiendo que era efectivo)
UPDATE cash_cuts
SET total_cash_sales = total_sales
WHERE total_cash_sales = 0 AND total_sales IS NOT NULL;

-- ========== ELIMINAR CAMPOS OBSOLETOS ==========

-- cut_number: No es necesario, shift_id + global_id son suficientes
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'cash_cuts' AND column_name = 'cut_number'
    ) THEN
        -- Primero eliminar el constraint UNIQUE
        ALTER TABLE cash_cuts DROP CONSTRAINT IF EXISTS cash_cuts_tenant_id_cut_number_key;
        -- Luego eliminar la columna
        ALTER TABLE cash_cuts DROP COLUMN cut_number;
        RAISE NOTICE '✅ Columna cut_number eliminada de cash_cuts';
    END IF;
END $$;

-- total_sales: Reemplazado por total_cash_sales + total_card_sales + total_credit_sales
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'cash_cuts' AND column_name = 'total_sales'
    ) THEN
        ALTER TABLE cash_cuts DROP COLUMN total_sales;
        RAISE NOTICE '✅ Columna total_sales eliminada de cash_cuts';
    END IF;
END $$;

-- expected_cash: Reemplazado por expected_cash_in_drawer (nombre más claro)
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'cash_cuts' AND column_name = 'expected_cash'
    ) THEN
        ALTER TABLE cash_cuts DROP COLUMN expected_cash;
        RAISE NOTICE '✅ Columna expected_cash eliminada de cash_cuts';
    END IF;
END $$;

-- cash_in_drawer: Reemplazado por counted_cash (nombre más claro)
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'cash_cuts' AND column_name = 'cash_in_drawer'
    ) THEN
        ALTER TABLE cash_cuts DROP COLUMN cash_in_drawer;
        RAISE NOTICE '✅ Columna cash_in_drawer eliminada de cash_cuts';
    END IF;
END $$;

-- ========== ÍNDICES ==========

CREATE INDEX IF NOT EXISTS idx_cash_cuts_shift ON cash_cuts(shift_id)
  WHERE shift_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_cash_cuts_closed ON cash_cuts(tenant_id, branch_id, is_closed);

CREATE INDEX IF NOT EXISTS idx_cash_cuts_end_time ON cash_cuts(tenant_id, branch_id, end_time DESC)
  WHERE end_time IS NOT NULL;

-- ========== COMENTARIOS ==========

COMMENT ON TABLE cash_cuts IS 'Cortes de caja 1:1 con Desktop CashDrawerSession - datos agregados listos para consumir';
COMMENT ON COLUMN cash_cuts.shift_id IS 'FK al turno asociado';
COMMENT ON COLUMN cash_cuts.initial_amount IS 'Monto inicial en caja al abrir turno';
COMMENT ON COLUMN cash_cuts.total_cash_sales IS 'Total de ventas pagadas en efectivo';
COMMENT ON COLUMN cash_cuts.total_card_sales IS 'Total de ventas pagadas con tarjeta';
COMMENT ON COLUMN cash_cuts.total_credit_sales IS 'Total de ventas a crédito';
COMMENT ON COLUMN cash_cuts.total_cash_payments IS 'Total de pagos de crédito recibidos en efectivo';
COMMENT ON COLUMN cash_cuts.total_card_payments IS 'Total de pagos de crédito recibidos con tarjeta';
COMMENT ON COLUMN cash_cuts.total_deposits IS 'Total de depósitos adicionales';
COMMENT ON COLUMN cash_cuts.total_withdrawals IS 'Total de retiros de efectivo';
COMMENT ON COLUMN cash_cuts.expected_cash_in_drawer IS 'Efectivo esperado calculado';
COMMENT ON COLUMN cash_cuts.counted_cash IS 'Efectivo contado físicamente al cerrar';
COMMENT ON COLUMN cash_cuts.difference IS 'Diferencia entre esperado y contado (counted - expected)';
COMMENT ON COLUMN cash_cuts.unregistered_weight_events IS 'Eventos de pesadas sin registro (Guardian)';
COMMENT ON COLUMN cash_cuts.scale_connection_events IS 'Eventos de desconexión de báscula (Guardian)';
COMMENT ON COLUMN cash_cuts.cancelled_sales IS 'Número de ventas canceladas en el turno';
COMMENT ON COLUMN cash_cuts.notes IS 'Notas adicionales del empleado sobre el corte';
COMMENT ON COLUMN cash_cuts.is_closed IS 'Indica si el corte está cerrado';
