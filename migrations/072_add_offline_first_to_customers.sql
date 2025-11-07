-- =====================================================
-- Migration: 072_add_offline_first_to_customers.sql
-- Descripción: Agregar columnas offline-first a tabla customers
-- =====================================================

-- ✅ Agregar global_id si no existe
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'customers' AND column_name = 'global_id'
    ) THEN
        ALTER TABLE customers ADD COLUMN global_id UUID;
        RAISE NOTICE '✅ Columna global_id agregada a customers';
    ELSE
        RAISE NOTICE 'ℹ️  Columna global_id ya existe en customers';
    END IF;
END $$;

-- ✅ Agregar terminal_id si no existe
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'customers' AND column_name = 'terminal_id'
    ) THEN
        ALTER TABLE customers ADD COLUMN terminal_id UUID;
        RAISE NOTICE '✅ Columna terminal_id agregada a customers';
    ELSE
        RAISE NOTICE 'ℹ️  Columna terminal_id ya existe en customers';
    END IF;
END $$;

-- ✅ Agregar local_op_seq si no existe
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'customers' AND column_name = 'local_op_seq'
    ) THEN
        ALTER TABLE customers ADD COLUMN local_op_seq INTEGER;
        RAISE NOTICE '✅ Columna local_op_seq agregada a customers';
    ELSE
        RAISE NOTICE 'ℹ️  Columna local_op_seq ya existe en customers';
    END IF;
END $$;

-- ✅ Agregar created_local_utc si no existe
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'customers' AND column_name = 'created_local_utc'
    ) THEN
        ALTER TABLE customers ADD COLUMN created_local_utc TIMESTAMPTZ;
        RAISE NOTICE '✅ Columna created_local_utc agregada a customers';
    ELSE
        RAISE NOTICE 'ℹ️  Columna created_local_utc ya existe en customers';
    END IF;
END $$;

-- ✅ Agregar device_event_raw si no existe
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'customers' AND column_name = 'device_event_raw'
    ) THEN
        ALTER TABLE customers ADD COLUMN device_event_raw BIGINT;
        RAISE NOTICE '✅ Columna device_event_raw agregada a customers';
    ELSE
        RAISE NOTICE 'ℹ️  Columna device_event_raw ya existe en customers';
    END IF;
END $$;

-- ✅ Crear índice UNIQUE en global_id (NO parcial, para ON CONFLICT)
CREATE UNIQUE INDEX IF NOT EXISTS uq_customers_global_id ON customers (global_id);

-- ✅ Índice para búsquedas por GlobalId
CREATE INDEX IF NOT EXISTS idx_customers_global_id ON customers (global_id)
    WHERE global_id IS NOT NULL;

-- ✅ Índice para TerminalId + LocalOpSeq
CREATE INDEX IF NOT EXISTS idx_customers_terminal_seq ON customers (terminal_id, local_op_seq)
    WHERE terminal_id IS NOT NULL AND local_op_seq IS NOT NULL;

-- ✅ Trigger para updated_at automático
DROP TRIGGER IF EXISTS trg_customers_updated_at ON customers;
CREATE TRIGGER trg_customers_updated_at
    BEFORE UPDATE ON customers
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

-- ✅ Comentarios
COMMENT ON COLUMN customers.global_id IS 'UUID único para idempotencia - previene duplicados en sincronización offline';
COMMENT ON COLUMN customers.terminal_id IS 'UUID de la terminal que creó el cliente';
COMMENT ON COLUMN customers.local_op_seq IS 'Secuencia local de operaciones para ordenamiento determinista';
COMMENT ON COLUMN customers.created_local_utc IS 'Timestamp de creación en UTC desde el dispositivo';
COMMENT ON COLUMN customers.device_event_raw IS 'Timestamp raw del dispositivo (epoch_ms o .NET ticks)';
