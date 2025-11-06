-- =====================================================
-- Migration: 060_fix_sales_references_to_ventas.sql
-- Descripción: Arreglar referencias a tabla 'sales' antigua que ya no existe
-- =====================================================
-- PROBLEMA: Migration 046 renombró 'sales' a 'ventas', pero:
-- - Migration 042 creó repartidor_assignments con FK a sales(id)
-- - database.js intenta crear tabla 'sales' (conflicto)
--
-- SOLUCIÓN:
-- 1. DROP constraint FK antigua en repartidor_assignments
-- 2. Recrear constraint apuntando a ventas(id_venta)
-- 3. DROP tabla sales si existe (residual de database.js)
-- =====================================================

-- ========== PASO 1: DROP constraint FK antigua ==========
DO $$
BEGIN
  -- Buscar y eliminar constraint FK que apunta a sales
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name LIKE '%sale_id%'
      AND table_name = 'repartidor_assignments'
      AND constraint_type = 'FOREIGN KEY'
  ) THEN
    -- Obtener nombre exacto de la constraint
    DECLARE
      constraint_name_var VARCHAR;
    BEGIN
      SELECT constraint_name INTO constraint_name_var
      FROM information_schema.table_constraints
      WHERE constraint_name LIKE '%sale_id%'
        AND table_name = 'repartidor_assignments'
        AND constraint_type = 'FOREIGN KEY'
      LIMIT 1;

      -- Eliminar constraint
      IF constraint_name_var IS NOT NULL THEN
        EXECUTE format('ALTER TABLE repartidor_assignments DROP CONSTRAINT IF EXISTS %I', constraint_name_var);
        RAISE NOTICE 'Dropped constraint: %', constraint_name_var;
      END IF;
    END;
  END IF;
END $$;

-- ========== PASO 2: Renombrar columna sale_id a venta_id (más consistente) ==========
ALTER TABLE repartidor_assignments
RENAME COLUMN sale_id TO venta_id;

-- ========== PASO 3: Crear nueva FK a ventas(id_venta) ==========
ALTER TABLE repartidor_assignments
ADD CONSTRAINT repartidor_assignments_venta_id_fkey
FOREIGN KEY (venta_id) REFERENCES ventas(id_venta) ON DELETE CASCADE;

-- ========== PASO 4: DROP tabla sales si existe (residual) ==========
DROP TABLE IF EXISTS sales CASCADE;
DROP TABLE IF EXISTS sale_items CASCADE;
DROP TABLE IF EXISTS sales_items CASCADE;

-- ========== PASO 5: Actualizar índices ==========
-- Recrear índice para venta_id
DROP INDEX IF EXISTS idx_repartidor_assignments_sale;
CREATE INDEX IF NOT EXISTS idx_repartidor_assignments_venta ON repartidor_assignments(venta_id);

-- ========== COMENTARIOS ==========
COMMENT ON COLUMN repartidor_assignments.venta_id IS 'FK a ventas.id_venta (antes era sale_id → sales.id)';
COMMENT ON CONSTRAINT repartidor_assignments_venta_id_fkey ON repartidor_assignments
IS 'FK a ventas.id_venta - corregido en migration 060';

-- ========== LOG ==========
DO $$
BEGIN
  RAISE NOTICE '✅ Migration 060 completada:';
  RAISE NOTICE '   - Actualizada FK: repartidor_assignments.venta_id → ventas.id_venta';
  RAISE NOTICE '   - Eliminadas tablas antiguas: sales, sale_items, sales_items';
  RAISE NOTICE '   - Renombrada columna: sale_id → venta_id';
END $$;
