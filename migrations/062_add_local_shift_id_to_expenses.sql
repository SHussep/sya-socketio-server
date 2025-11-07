-- =====================================================
-- Migration: 062_add_local_shift_id_to_expenses.sql
-- Descripción: Agregar columna local_shift_id a tabla expenses
-- =====================================================

-- ✅ local_shift_id: Referencia al ShiftId del Desktop (para reconciliación offline-first)
-- Este es el ID del shift EN EL DESKTOP, no el shift remoto
-- Sirve para vincular gastos a turnos locales antes de que el shift se sincronice

DO $$
BEGIN
    -- Check if column exists
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'expenses'
        AND column_name = 'local_shift_id'
    ) THEN
        ALTER TABLE expenses
        ADD COLUMN local_shift_id INTEGER;

        RAISE NOTICE '✅ Columna local_shift_id agregada a expenses';
    ELSE
        RAISE NOTICE 'ℹ️  Columna local_shift_id ya existe en expenses';
    END IF;
END $$;

-- Crear índice para búsquedas por local_shift_id
CREATE INDEX IF NOT EXISTS idx_expenses_local_shift_id ON expenses(local_shift_id)
  WHERE local_shift_id IS NOT NULL;

COMMENT ON COLUMN expenses.local_shift_id IS 'ID del shift en el Desktop (antes de sincronización) - usado para reconciliación offline-first';
