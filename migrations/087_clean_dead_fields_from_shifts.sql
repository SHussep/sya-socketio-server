-- =====================================================
-- Migration: 087_clean_dead_fields_from_shifts.sql
-- Descripción: Eliminar campos muertos de shifts que Desktop nunca actualiza
-- =====================================================

-- PROBLEMA: shifts tiene campos que Desktop nunca sincroniza:
--   - initial_amount: Desktop lo guarda localmente, no lo sincroniza
--   - final_amount: Desktop lo guarda localmente, no lo sincroniza
--   - transaction_counter: Desktop no lo usa
--   - is_cash_cut_open: Desktop no lo sincroniza, lo maneja localmente

-- SOLUCIÓN: Eliminar campos zombies que solo ocupan espacio

-- ========== ELIMINAR CAMPOS MUERTOS ==========

-- initial_amount: Desktop no lo sincroniza (está en cash_cuts.initial_amount)
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'shifts' AND column_name = 'initial_amount'
    ) THEN
        ALTER TABLE shifts DROP COLUMN initial_amount;
        RAISE NOTICE '✅ Columna initial_amount eliminada de shifts (dato en cash_cuts)';
    END IF;
END $$;

-- final_amount: Desktop no lo sincroniza (está en cash_cuts.counted_cash)
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'shifts' AND column_name = 'final_amount'
    ) THEN
        ALTER TABLE shifts DROP COLUMN final_amount;
        RAISE NOTICE '✅ Columna final_amount eliminada de shifts (dato en cash_cuts)';
    END IF;
END $$;

-- transaction_counter: Desktop no lo usa
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'shifts' AND column_name = 'transaction_counter'
    ) THEN
        ALTER TABLE shifts DROP COLUMN transaction_counter;
        RAISE NOTICE '✅ Columna transaction_counter eliminada de shifts (no usado)';
    END IF;
END $$;

-- is_cash_cut_open: Desktop lo maneja localmente, no lo sincroniza
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'shifts' AND column_name = 'is_cash_cut_open'
    ) THEN
        ALTER TABLE shifts DROP COLUMN is_cash_cut_open;
        RAISE NOTICE '✅ Columna is_cash_cut_open eliminada de shifts (estado local)';
    END IF;
END $$;

-- ========== COMENTARIOS ACTUALIZADOS ==========

COMMENT ON TABLE shifts IS 'Turnos de empleados - solo campos sincronizados desde Desktop';
COMMENT ON COLUMN shifts.start_time IS 'Hora de inicio del turno (sincronizado desde Desktop)';
COMMENT ON COLUMN shifts.end_time IS 'Hora de cierre del turno (sincronizado desde Desktop)';
COMMENT ON COLUMN shifts.employee_id IS 'Empleado responsable del turno';

-- Nota: Para datos de caja (initial_amount, final_amount, etc.) ver tabla cash_cuts
