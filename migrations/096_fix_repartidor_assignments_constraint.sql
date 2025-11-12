-- Migration 096: Fix repartidor_assignments unique constraint
-- ==============================================================================
-- OBJETIVO: Aplicar el constraint UNIQUE en sale_id de forma segura
-- Solo se aplica si no hay duplicados en la base de datos
-- ==============================================================================

-- Verificar si hay duplicados antes de aplicar el constraint
DO $$
DECLARE
    duplicate_count INTEGER;
BEGIN
    -- Contar cuántos sale_id están duplicados
    SELECT COUNT(*) INTO duplicate_count
    FROM (
        SELECT sale_id
        FROM repartidor_assignments
        GROUP BY sale_id
        HAVING COUNT(*) > 1
    ) AS duplicates;

    IF duplicate_count > 0 THEN
        RAISE NOTICE 'ADVERTENCIA: Se encontraron % sale_id duplicados en repartidor_assignments', duplicate_count;
        RAISE NOTICE 'No se aplicará el constraint UNIQUE. Limpia los duplicados manualmente si es necesario.';
    ELSE
        -- No hay duplicados, es seguro aplicar el constraint
        BEGIN
            ALTER TABLE repartidor_assignments
            ADD CONSTRAINT unique_repartidor_assignments_sale UNIQUE(sale_id);
            RAISE NOTICE 'Constraint UNIQUE en sale_id aplicado exitosamente';
        EXCEPTION
            WHEN duplicate_table THEN
                RAISE NOTICE 'Constraint UNIQUE ya existe, omitiendo...';
            WHEN duplicate_object THEN
                RAISE NOTICE 'Constraint UNIQUE ya existe, omitiendo...';
            WHEN OTHERS THEN
                RAISE NOTICE 'Error aplicando constraint: %', SQLERRM;
        END;
    END IF;
END $$;

-- Comentario de documentación
COMMENT ON CONSTRAINT unique_repartidor_assignments_sale ON repartidor_assignments
IS 'Garantiza relación 1:1 entre ventas y asignaciones (una venta puede tener máximo una asignación)';
