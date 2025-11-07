-- =====================================================
-- Migration: 062c_add_missing_offline_columns_to_ventas_detalle.sql
-- Descripción: Agregar columnas offline-first faltantes a ventas_detalle
-- =====================================================

-- ✅ Agregar global_id si no existe
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'ventas_detalle' AND column_name = 'global_id'
    ) THEN
        ALTER TABLE ventas_detalle ADD COLUMN global_id VARCHAR(255);
        RAISE NOTICE '✅ Columna global_id agregada a ventas_detalle';
    ELSE
        RAISE NOTICE 'ℹ️  Columna global_id ya existe en ventas_detalle';
    END IF;
END $$;

-- ✅ Agregar terminal_id si no existe
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'ventas_detalle' AND column_name = 'terminal_id'
    ) THEN
        ALTER TABLE ventas_detalle ADD COLUMN terminal_id VARCHAR(255);
        RAISE NOTICE '✅ Columna terminal_id agregada a ventas_detalle';
    ELSE
        RAISE NOTICE 'ℹ️  Columna terminal_id ya existe en ventas_detalle';
    END IF;
END $$;

-- ✅ Agregar local_op_seq si no existe
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'ventas_detalle' AND column_name = 'local_op_seq'
    ) THEN
        ALTER TABLE ventas_detalle ADD COLUMN local_op_seq INTEGER;
        RAISE NOTICE '✅ Columna local_op_seq agregada a ventas_detalle';
    ELSE
        RAISE NOTICE 'ℹ️  Columna local_op_seq ya existe en ventas_detalle';
    END IF;
END $$;

-- ✅ Agregar created_local_utc si no existe
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'ventas_detalle' AND column_name = 'created_local_utc'
    ) THEN
        ALTER TABLE ventas_detalle ADD COLUMN created_local_utc TEXT;
        RAISE NOTICE '✅ Columna created_local_utc agregada a ventas_detalle';
    ELSE
        RAISE NOTICE 'ℹ️  Columna created_local_utc ya existe en ventas_detalle';
    END IF;
END $$;

-- ✅ Agregar device_event_raw si no existe
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'ventas_detalle' AND column_name = 'device_event_raw'
    ) THEN
        ALTER TABLE ventas_detalle ADD COLUMN device_event_raw BIGINT;
        RAISE NOTICE '✅ Columna device_event_raw agregada a ventas_detalle';
    ELSE
        RAISE NOTICE 'ℹ️  Columna device_event_raw ya existe en ventas_detalle';
    END IF;
END $$;

COMMENT ON COLUMN ventas_detalle.global_id IS 'UUID único para idempotencia';
COMMENT ON COLUMN ventas_detalle.terminal_id IS 'UUID de la terminal';
COMMENT ON COLUMN ventas_detalle.local_op_seq IS 'Secuencia local de operaciones';
COMMENT ON COLUMN ventas_detalle.created_local_utc IS 'Timestamp ISO 8601 desde el dispositivo';
COMMENT ON COLUMN ventas_detalle.device_event_raw IS 'Timestamp raw del dispositivo';
