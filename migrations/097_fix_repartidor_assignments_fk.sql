-- Migration 097: Fix repartidor_assignments foreign key to ventas
-- ==============================================================================
-- OBJETIVO: Corregir el FK de sale_id que apunta a tabla incorrecta
-- El FK debe apuntar a ventas(id_venta) no a sales(id)
-- ==============================================================================

-- 1. Eliminar el constraint FK incorrecto (si existe)
DO $$
BEGIN
    -- Intentar eliminar el constraint que apunta a 'sales'
    IF EXISTS (
        SELECT 1
        FROM information_schema.table_constraints
        WHERE constraint_name LIKE '%repartidor_assignments%sale%'
          AND table_name = 'repartidor_assignments'
    ) THEN
        ALTER TABLE repartidor_assignments
        DROP CONSTRAINT IF EXISTS repartidor_assignments_sale_id_fkey;

        RAISE NOTICE 'Constraint FK a sales eliminado';
    END IF;
END $$;

-- 2. Agregar el constraint FK correcto apuntando a ventas(id_venta)
DO $$
BEGIN
    -- Verificar si ya existe el constraint correcto
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
        WHERE tc.table_name = 'repartidor_assignments'
          AND tc.constraint_type = 'FOREIGN KEY'
          AND kcu.column_name = 'sale_id'
          AND kcu.constraint_name LIKE '%ventas%'
    ) THEN
        ALTER TABLE repartidor_assignments
        ADD CONSTRAINT repartidor_assignments_sale_id_fkey_ventas
        FOREIGN KEY (sale_id)
        REFERENCES ventas(id_venta)
        ON DELETE CASCADE;

        RAISE NOTICE 'Constraint FK a ventas creado exitosamente';
    ELSE
        RAISE NOTICE 'Constraint FK a ventas ya existe';
    END IF;
END $$;

-- Comentario de documentación
COMMENT ON CONSTRAINT repartidor_assignments_sale_id_fkey_ventas ON repartidor_assignments
IS 'FK a tabla ventas - Cada asignación está asociada a una venta específica';
