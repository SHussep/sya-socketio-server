-- =====================================================
-- Migration: 062b_add_missing_offline_columns_to_ventas.sql
-- Descripción: PRIMERO agregar columnas offline-first faltantes ANTES de convertir tipos
-- =====================================================
-- CRÍTICO: Esta migración DEBE ejecutarse ANTES de 063 (conversión a UUID)
-- =====================================================

-- ✅ Agregar global_id si no existe (como VARCHAR primero, 063 la convertirá a UUID)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'ventas' AND column_name = 'global_id'
    ) THEN
        ALTER TABLE ventas ADD COLUMN global_id VARCHAR(255);
        RAISE NOTICE '✅ Columna global_id agregada a ventas';
    ELSE
        RAISE NOTICE 'ℹ️  Columna global_id ya existe en ventas';
    END IF;
END $$;

-- ✅ Agregar terminal_id si no existe (como VARCHAR primero, 063 la convertirá a UUID)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'ventas' AND column_name = 'terminal_id'
    ) THEN
        ALTER TABLE ventas ADD COLUMN terminal_id VARCHAR(255);
        RAISE NOTICE '✅ Columna terminal_id agregada a ventas';
    ELSE
        RAISE NOTICE 'ℹ️  Columna terminal_id ya existe en ventas';
    END IF;
END $$;

-- ✅ Agregar local_op_seq si no existe
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'ventas' AND column_name = 'local_op_seq'
    ) THEN
        ALTER TABLE ventas ADD COLUMN local_op_seq INTEGER;
        RAISE NOTICE '✅ Columna local_op_seq agregada a ventas';
    ELSE
        RAISE NOTICE 'ℹ️  Columna local_op_seq ya existe en ventas';
    END IF;
END $$;

-- ✅ Agregar created_local_utc si no existe
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'ventas' AND column_name = 'created_local_utc'
    ) THEN
        ALTER TABLE ventas ADD COLUMN created_local_utc TEXT;
        RAISE NOTICE '✅ Columna created_local_utc agregada a ventas';
    ELSE
        RAISE NOTICE 'ℹ️  Columna created_local_utc ya existe en ventas';
    END IF;
END $$;

-- ✅ Agregar device_event_raw si no existe
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'ventas' AND column_name = 'device_event_raw'
    ) THEN
        ALTER TABLE ventas ADD COLUMN device_event_raw BIGINT;
        RAISE NOTICE '✅ Columna device_event_raw agregada a ventas';
    ELSE
        RAISE NOTICE 'ℹ️  Columna device_event_raw ya existe en ventas';
    END IF;
END $$;

-- ✅ Comentarios
COMMENT ON COLUMN ventas.global_id IS 'UUID único para idempotencia (será convertido a UUID en migración 063)';
COMMENT ON COLUMN ventas.terminal_id IS 'UUID de la terminal (será convertido a UUID en migración 063)';
COMMENT ON COLUMN ventas.local_op_seq IS 'Secuencia local de operaciones para ordenamiento determinista';
COMMENT ON COLUMN ventas.created_local_utc IS 'Timestamp ISO 8601 de creación en UTC desde el dispositivo';
COMMENT ON COLUMN ventas.device_event_raw IS 'Timestamp raw del dispositivo (epoch_ms o .NET ticks)';
