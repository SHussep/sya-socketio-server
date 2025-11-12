-- Migration 100: Fix repartidor_assignments naming convention
-- ==============================================================================
-- OBJETIVO:
-- 1. Usar convención en ESPAÑOL consistente con tabla ventas
-- 2. Eliminar campos de sincronización que son solo para SQLite local
-- ==============================================================================

DO $$
BEGIN
    RAISE NOTICE 'Corrigiendo convención de nombres en repartidor_assignments...';

    -- 1. Renombrar sale_id → id_venta (si existe sale_id)
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'repartidor_assignments' AND column_name = 'sale_id'
    ) THEN
        ALTER TABLE repartidor_assignments RENAME COLUMN sale_id TO id_venta;
        RAISE NOTICE 'Renombrado: sale_id → id_venta';
    END IF;

    -- 2. Eliminar campos de sincronización (solo para SQLite local, innecesarios en PostgreSQL)
    ALTER TABLE repartidor_assignments DROP COLUMN IF EXISTS synced;
    ALTER TABLE repartidor_assignments DROP COLUMN IF EXISTS synced_at;
    ALTER TABLE repartidor_assignments DROP COLUMN IF EXISTS needs_update;
    ALTER TABLE repartidor_assignments DROP COLUMN IF EXISTS last_modified_local_utc;
    RAISE NOTICE 'Campos de sincronización eliminados (solo necesarios en SQLite local)';

    -- 3. Asegurar que id_venta existe
    ALTER TABLE repartidor_assignments ADD COLUMN IF NOT EXISTS id_venta INTEGER;

    -- 4. Configurar id_venta como NOT NULL
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'repartidor_assignments'
          AND column_name = 'id_venta'
          AND is_nullable = 'YES'
    ) THEN
        UPDATE repartidor_assignments SET id_venta = 0 WHERE id_venta IS NULL;
        ALTER TABLE repartidor_assignments ALTER COLUMN id_venta SET NOT NULL;
        RAISE NOTICE 'Columna id_venta configurada como NOT NULL';
    END IF;

    -- 5. Eliminar FKs viejos si existen
    ALTER TABLE repartidor_assignments DROP CONSTRAINT IF EXISTS repartidor_assignments_sale_id_fkey;
    ALTER TABLE repartidor_assignments DROP CONSTRAINT IF EXISTS repartidor_assignments_sale_id_fkey_ventas;

    -- 6. Crear FK correcto a ventas(id_venta)
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_name = 'repartidor_assignments'
          AND constraint_name = 'repartidor_assignments_id_venta_fkey'
    ) THEN
        ALTER TABLE repartidor_assignments
        ADD CONSTRAINT repartidor_assignments_id_venta_fkey
        FOREIGN KEY (id_venta) REFERENCES ventas(id_venta) ON DELETE CASCADE;
        RAISE NOTICE 'FK a ventas(id_venta) creado';
    END IF;

    -- 7. Crear índice
    CREATE INDEX IF NOT EXISTS idx_repartidor_assignments_id_venta ON repartidor_assignments(id_venta);

    RAISE NOTICE 'Migration 100 completada - convención en ESPAÑOL aplicada';
END $$;
