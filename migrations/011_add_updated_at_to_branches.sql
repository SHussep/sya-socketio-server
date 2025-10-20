-- ═══════════════════════════════════════════════════════════════════════════
-- Migración 011: Agregar columna updated_at a tabla branches
-- ═══════════════════════════════════════════════════════════════════════════
-- Fecha: 2025-10-19
-- Descripción: Agrega la columna updated_at a la tabla branches para registrar
--              cuándo fue la última actualización de cada sucursal.
-- ═══════════════════════════════════════════════════════════════════════════

-- Verificar si la columna ya existe antes de agregarla
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'branches'
        AND column_name = 'updated_at'
    ) THEN
        ALTER TABLE branches
        ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

        -- Actualizar registros existentes con la fecha de creación
        UPDATE branches
        SET updated_at = created_at
        WHERE updated_at IS NULL;

        RAISE NOTICE 'Columna updated_at agregada a tabla branches';
    ELSE
        RAISE NOTICE 'Columna updated_at ya existe en tabla branches';
    END IF;
END $$;
