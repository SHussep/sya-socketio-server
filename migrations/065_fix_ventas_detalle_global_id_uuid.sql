-- =====================================================
-- Migration: 065_fix_ventas_detalle_global_id_uuid.sql
-- Descripción: Convertir global_id a UUID y agregar constraint UNIQUE para idempotencia
-- =====================================================

-- ✅ PASO 1: Convertir global_id de VARCHAR a UUID
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'ventas_detalle'
        AND column_name = 'global_id'
        AND data_type = 'character varying'
    ) THEN
        ALTER TABLE ventas_detalle
        ALTER COLUMN global_id TYPE uuid USING (
            CASE
                WHEN global_id IS NULL THEN NULL
                WHEN global_id = '' THEN NULL
                ELSE global_id::uuid
            END
        );

        RAISE NOTICE '✅ Columna global_id convertida de VARCHAR a UUID en ventas_detalle';
    ELSE
        RAISE NOTICE 'ℹ️  Columna global_id ya es tipo UUID o no existe en ventas_detalle';
    END IF;
END $$;

-- ✅ PASO 2: Crear UNIQUE constraint en global_id (ignorar NULLs)
CREATE UNIQUE INDEX IF NOT EXISTS uq_ventas_detalle_global_id
    ON ventas_detalle (global_id)
    WHERE global_id IS NOT NULL;

-- ✅ PASO 3: Convertir terminal_id a UUID si existe como VARCHAR
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'ventas_detalle'
        AND column_name = 'terminal_id'
        AND data_type = 'character varying'
    ) THEN
        ALTER TABLE ventas_detalle
        ALTER COLUMN terminal_id TYPE uuid USING (
            CASE
                WHEN terminal_id IS NULL THEN NULL
                WHEN terminal_id = '' THEN NULL
                ELSE terminal_id::uuid
            END
        );

        RAISE NOTICE '✅ Columna terminal_id convertida de VARCHAR a UUID en ventas_detalle';
    ELSE
        RAISE NOTICE 'ℹ️  Columna terminal_id ya es tipo UUID o no existe en ventas_detalle';
    END IF;
END $$;

-- ✅ PASO 4: Crear índice para búsquedas rápidas por GlobalId
CREATE INDEX IF NOT EXISTS idx_ventas_detalle_global_id
    ON ventas_detalle (global_id)
    WHERE global_id IS NOT NULL;

-- ✅ PASO 5: Crear índice para TerminalId + LocalOpSeq
CREATE INDEX IF NOT EXISTS idx_ventas_detalle_terminal_seq
    ON ventas_detalle (terminal_id, local_op_seq)
    WHERE terminal_id IS NOT NULL AND local_op_seq IS NOT NULL;

-- ✅ PASO 6: Actualizar comentarios
COMMENT ON COLUMN ventas_detalle.global_id IS 'UUID único para idempotencia - previene duplicados en sincronización offline';
COMMENT ON COLUMN ventas_detalle.terminal_id IS 'UUID de la terminal que creó la línea de venta';
