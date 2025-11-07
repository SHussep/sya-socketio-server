-- =====================================================
-- Migration: 061_add_updated_at_to_shifts.sql
-- Descripción: Agregar columna updated_at a tabla shifts
-- =====================================================

-- Agregar updated_at column si no existe
DO $$
BEGIN
    -- Check if column exists
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'shifts'
        AND column_name = 'updated_at'
    ) THEN
        ALTER TABLE shifts
        ADD COLUMN updated_at TIMESTAMPTZ DEFAULT NOW();

        RAISE NOTICE '✅ Columna updated_at agregada a shifts';
    ELSE
        RAISE NOTICE 'ℹ️  Columna updated_at ya existe en shifts';
    END IF;
END $$;

COMMENT ON COLUMN shifts.updated_at IS 'Timestamp de última actualización del turno';
