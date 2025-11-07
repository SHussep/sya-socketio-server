-- =====================================================
-- Migration: 064_fix_expenses_global_id_uuid.sql
-- Descripción: Convertir global_id a UUID y agregar constraint UNIQUE para idempotencia
-- =====================================================

-- ✅ PASO 1: Convertir global_id de VARCHAR a UUID
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'expenses'
        AND column_name = 'global_id'
        AND data_type = 'character varying'
    ) THEN
        ALTER TABLE expenses
        ALTER COLUMN global_id TYPE uuid USING (
            CASE
                WHEN global_id IS NULL THEN NULL
                WHEN global_id = '' THEN NULL
                ELSE global_id::uuid
            END
        );

        RAISE NOTICE '✅ Columna global_id convertida de VARCHAR a UUID en expenses';
    ELSE
        RAISE NOTICE 'ℹ️  Columna global_id ya es tipo UUID o no existe en expenses';
    END IF;
END $$;

-- ✅ PASO 2: Crear UNIQUE constraint en global_id (ignorar NULLs)
DROP INDEX IF EXISTS idx_expenses_global_id_unique;
CREATE UNIQUE INDEX IF NOT EXISTS uq_expenses_global_id
    ON expenses (global_id)
    WHERE global_id IS NOT NULL;

-- ✅ PASO 3: Convertir terminal_id a UUID si existe como VARCHAR
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'expenses'
        AND column_name = 'terminal_id'
        AND data_type = 'character varying'
    ) THEN
        ALTER TABLE expenses
        ALTER COLUMN terminal_id TYPE uuid USING (
            CASE
                WHEN terminal_id IS NULL THEN NULL
                WHEN terminal_id = '' THEN NULL
                ELSE terminal_id::uuid
            END
        );

        RAISE NOTICE '✅ Columna terminal_id convertida de VARCHAR a UUID en expenses';
    ELSE
        RAISE NOTICE 'ℹ️  Columna terminal_id ya es tipo UUID o no existe en expenses';
    END IF;
END $$;

-- ✅ PASO 4: Reemplazar índice antiguo
DROP INDEX IF EXISTS idx_expenses_global_id;
CREATE INDEX IF NOT EXISTS idx_expenses_global_id_lookup
    ON expenses (global_id)
    WHERE global_id IS NOT NULL;

-- ✅ PASO 5: Recrear índice para TerminalId + LocalOpSeq
DROP INDEX IF EXISTS idx_expenses_terminal_seq;
CREATE INDEX IF NOT EXISTS idx_expenses_terminal_seq
    ON expenses (terminal_id, local_op_seq)
    WHERE terminal_id IS NOT NULL AND local_op_seq IS NOT NULL;

-- ✅ PASO 6: Actualizar comentarios
COMMENT ON COLUMN expenses.global_id IS 'UUID único para idempotencia - previene duplicados en sincronización offline';
COMMENT ON COLUMN expenses.terminal_id IS 'UUID de la terminal que creó el gasto';
