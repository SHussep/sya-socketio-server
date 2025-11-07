-- =====================================================
-- Migration: 063_fix_ventas_global_id_uuid.sql
-- Descripción: Convertir global_id a UUID y agregar constraint UNIQUE para idempotencia
-- =====================================================

-- ✅ PASO 1: Convertir global_id de VARCHAR a UUID
DO $$
BEGIN
    -- Si la columna ya es UUID, no hacer nada
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'ventas'
        AND column_name = 'global_id'
        AND data_type = 'character varying'
    ) THEN
        -- Convertir valores existentes NULL a NULL explícito, y strings a UUID
        ALTER TABLE ventas
        ALTER COLUMN global_id TYPE uuid USING (
            CASE
                WHEN global_id IS NULL THEN NULL
                WHEN global_id = '' THEN NULL
                ELSE global_id::uuid
            END
        );

        RAISE NOTICE '✅ Columna global_id convertida de VARCHAR a UUID en ventas';
    ELSE
        RAISE NOTICE 'ℹ️  Columna global_id ya es tipo UUID o no existe en ventas';
    END IF;
END $$;

-- ✅ PASO 2: Crear UNIQUE constraint en global_id (ignorar NULLs)
CREATE UNIQUE INDEX IF NOT EXISTS uq_ventas_global_id
    ON ventas (global_id)
    WHERE global_id IS NOT NULL;

-- ✅ PASO 3: Convertir terminal_id a UUID si existe como VARCHAR
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'ventas'
        AND column_name = 'terminal_id'
        AND data_type = 'character varying'
    ) THEN
        ALTER TABLE ventas
        ALTER COLUMN terminal_id TYPE uuid USING (
            CASE
                WHEN terminal_id IS NULL THEN NULL
                WHEN terminal_id = '' THEN NULL
                ELSE terminal_id::uuid
            END
        );

        RAISE NOTICE '✅ Columna terminal_id convertida de VARCHAR a UUID en ventas';
    ELSE
        RAISE NOTICE 'ℹ️  Columna terminal_id ya es tipo UUID o no existe en ventas';
    END IF;
END $$;

-- ✅ PASO 4: Agregar índice compuesto para evitar duplicados por ticket_number + terminal_id
CREATE UNIQUE INDEX IF NOT EXISTS uq_ventas_ticket_per_terminal
    ON ventas (tenant_id, branch_id, ticket_number, terminal_id)
    WHERE terminal_id IS NOT NULL;

-- ✅ PASO 5: Crear índice para búsquedas rápidas por GlobalId
CREATE INDEX IF NOT EXISTS idx_ventas_global_id
    ON ventas (global_id)
    WHERE global_id IS NOT NULL;

-- ✅ PASO 6: Crear índice para TerminalId + LocalOpSeq (ordenamiento determinista)
CREATE INDEX IF NOT EXISTS idx_ventas_terminal_seq
    ON ventas (terminal_id, local_op_seq)
    WHERE terminal_id IS NOT NULL AND local_op_seq IS NOT NULL;

-- ✅ PASO 7: Actualizar comentarios
COMMENT ON COLUMN ventas.global_id IS 'UUID único para idempotencia - previene duplicados en sincronización offline';
COMMENT ON COLUMN ventas.terminal_id IS 'UUID de la terminal que creó la venta (ej: e594c7ef-7ef8-4099-8593-fb73167160ed)';
COMMENT ON COLUMN ventas.local_op_seq IS 'Secuencia local de operaciones para ordenamiento determinista';
COMMENT ON COLUMN ventas.created_local_utc IS 'Timestamp ISO 8601 de creación en UTC desde el dispositivo';
COMMENT ON COLUMN ventas.device_event_raw IS 'Timestamp raw del dispositivo (epoch_ms o .NET ticks)';
