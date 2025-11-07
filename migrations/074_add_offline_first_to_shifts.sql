-- =====================================================
-- Migration: 074_add_offline_first_to_shifts.sql
-- Descripción: Agregar columnas offline-first a tabla shifts para sincronización idempotente
-- =====================================================

-- Agregar columna global_id (UUID único para idempotencia)
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS global_id VARCHAR(36);

-- Agregar columna terminal_id (UUID del dispositivo)
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS terminal_id VARCHAR(36);

-- Agregar columna local_op_seq (secuencia local)
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS local_op_seq BIGINT;

-- Agregar columna created_local_utc (timestamp ISO 8601)
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS created_local_utc VARCHAR(50);

-- Agregar columna device_event_raw (ticks .NET)
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS device_event_raw BIGINT;

-- Crear índice ÚNICO en global_id para prevenir duplicados en sync
CREATE UNIQUE INDEX IF NOT EXISTS shifts_uq_global_id ON shifts(global_id);

-- Comentarios
COMMENT ON COLUMN shifts.global_id IS 'UUID global único para idempotencia en sincronización (puede ser NULL para shifts creados en servidor)';
COMMENT ON COLUMN shifts.terminal_id IS 'UUID del dispositivo que creó este shift';
COMMENT ON COLUMN shifts.local_op_seq IS 'Secuencia local de operación para ordenar eventos';
COMMENT ON COLUMN shifts.created_local_utc IS 'Timestamp de creación en formato ISO 8601 UTC';
COMMENT ON COLUMN shifts.device_event_raw IS 'Timestamp raw del dispositivo (.NET ticks) para resolución de conflictos';

-- Verificación
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'shifts' AND column_name = 'global_id'
    ) THEN
        RAISE NOTICE '✅ Columna global_id agregada a shifts';
    ELSE
        RAISE EXCEPTION '❌ Error: Columna global_id no fue agregada';
    END IF;

    IF EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE indexname = 'shifts_uq_global_id'
    ) THEN
        RAISE NOTICE '✅ Índice shifts_uq_global_id creado exitosamente';
    ELSE
        RAISE EXCEPTION '❌ Error: Índice shifts_uq_global_id no fue creado';
    END IF;
END $$;
