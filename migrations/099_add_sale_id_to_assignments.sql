-- Migration 099: Add sale_id column to repartidor_assignments if missing
-- ==============================================================================
-- OBJETIVO: Asegurar que la columna sale_id existe en repartidor_assignments
-- Esta columna es CRÍTICA para la relación con ventas
-- ==============================================================================

DO $$
BEGIN
    RAISE NOTICE 'Verificando columna sale_id en repartidor_assignments...';

    -- Agregar sale_id si no existe
    ALTER TABLE repartidor_assignments ADD COLUMN IF NOT EXISTS sale_id INTEGER;
    RAISE NOTICE 'Columna sale_id agregada o ya existía';

    -- Si sale_id permite NULL, configurarlo como NOT NULL
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'repartidor_assignments'
          AND column_name = 'sale_id'
          AND is_nullable = 'YES'
    ) THEN
        -- Poner valor por defecto para registros sin sale_id
        UPDATE repartidor_assignments SET sale_id = 0 WHERE sale_id IS NULL;
        ALTER TABLE repartidor_assignments ALTER COLUMN sale_id SET NOT NULL;
        RAISE NOTICE 'Columna sale_id configurada como NOT NULL';
    END IF;

    -- Agregar FK a ventas si no existe
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_name = 'repartidor_assignments'
          AND constraint_type = 'FOREIGN KEY'
          AND constraint_name LIKE '%sale%'
    ) THEN
        ALTER TABLE repartidor_assignments
        ADD CONSTRAINT repartidor_assignments_sale_id_fkey
        FOREIGN KEY (sale_id) REFERENCES ventas(id_venta) ON DELETE CASCADE;
        RAISE NOTICE 'FK a ventas(id_venta) creado exitosamente';
    ELSE
        RAISE NOTICE 'FK a ventas ya existe';
    END IF;

    -- Crear índice si no existe
    CREATE INDEX IF NOT EXISTS idx_repartidor_assignments_sale ON repartidor_assignments(sale_id);
    RAISE NOTICE 'Índice en sale_id creado o ya existía';

    RAISE NOTICE 'Migration 099 completada exitosamente';
END $$;
