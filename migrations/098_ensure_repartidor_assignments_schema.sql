-- Migration 098: Ensure repartidor_assignments has correct schema
-- ==============================================================================
-- OBJETIVO: Garantizar que la tabla tenga el esquema correcto independientemente
-- de si las migrations anteriores se aplicaron o no
-- ==============================================================================

DO $$
BEGIN
    -- Verificar si existe la columna antigua cantidad_asignada
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'repartidor_assignments' AND column_name = 'cantidad_asignada'
    ) THEN
        RAISE NOTICE 'Esquema viejo detectado - aplicando migration 094...';

        -- 1. Agregar nuevas columnas si no existen
        ALTER TABLE repartidor_assignments ADD COLUMN IF NOT EXISTS assigned_quantity NUMERIC(10,2);
        ALTER TABLE repartidor_assignments ADD COLUMN IF NOT EXISTS assigned_amount NUMERIC(10,2);
        ALTER TABLE repartidor_assignments ADD COLUMN IF NOT EXISTS unit_price NUMERIC(10,2);
        ALTER TABLE repartidor_assignments ADD COLUMN IF NOT EXISTS created_by_employee_id INTEGER;
        ALTER TABLE repartidor_assignments ADD COLUMN IF NOT EXISTS shift_id INTEGER;
        ALTER TABLE repartidor_assignments ADD COLUMN IF NOT EXISTS repartidor_shift_id INTEGER;
        ALTER TABLE repartidor_assignments ADD COLUMN IF NOT EXISTS status VARCHAR(30);
        ALTER TABLE repartidor_assignments ADD COLUMN IF NOT EXISTS needs_update BOOLEAN DEFAULT false;
        ALTER TABLE repartidor_assignments ADD COLUMN IF NOT EXISTS last_modified_local_utc TIMESTAMP WITH TIME ZONE;

        -- 2. Migrar datos de columnas viejas a nuevas
        UPDATE repartidor_assignments
        SET assigned_quantity = cantidad_asignada
        WHERE assigned_quantity IS NULL AND cantidad_asignada IS NOT NULL;

        UPDATE repartidor_assignments
        SET assigned_amount = monto_asignado
        WHERE assigned_amount IS NULL AND monto_asignado IS NOT NULL;

        UPDATE repartidor_assignments
        SET repartidor_shift_id = turno_repartidor_id
        WHERE repartidor_shift_id IS NULL AND turno_repartidor_id IS NOT NULL;

        UPDATE repartidor_assignments
        SET status = estado
        WHERE (status IS NULL OR status = '') AND estado IS NOT NULL;

        -- 3. Calcular unit_price de registros existentes
        UPDATE repartidor_assignments
        SET unit_price = CASE
            WHEN assigned_quantity > 0 THEN assigned_amount / assigned_quantity
            ELSE 0
        END
        WHERE unit_price IS NULL;

        -- 4. Hacer columnas NOT NULL después de migrar datos
        ALTER TABLE repartidor_assignments ALTER COLUMN assigned_quantity SET NOT NULL;
        ALTER TABLE repartidor_assignments ALTER COLUMN assigned_amount SET NOT NULL;
        ALTER TABLE repartidor_assignments ALTER COLUMN unit_price SET NOT NULL;
        ALTER TABLE repartidor_assignments ALTER COLUMN status SET NOT NULL;
        ALTER TABLE repartidor_assignments ALTER COLUMN status SET DEFAULT 'pending';

        -- 5. Eliminar columnas redundantes viejas
        ALTER TABLE repartidor_assignments DROP COLUMN IF EXISTS cantidad_asignada;
        ALTER TABLE repartidor_assignments DROP COLUMN IF EXISTS monto_asignado;
        ALTER TABLE repartidor_assignments DROP COLUMN IF EXISTS cantidad_devuelta;
        ALTER TABLE repartidor_assignments DROP COLUMN IF EXISTS monto_devuelto;
        ALTER TABLE repartidor_assignments DROP COLUMN IF EXISTS estado;
        ALTER TABLE repartidor_assignments DROP COLUMN IF EXISTS turno_repartidor_id;
        ALTER TABLE repartidor_assignments DROP COLUMN IF EXISTS remote_id;
        ALTER TABLE repartidor_assignments DROP COLUMN IF EXISTS last_sync_error;
        ALTER TABLE repartidor_assignments DROP COLUMN IF EXISTS fecha_devoluciones;

        RAISE NOTICE 'Migración de esquema viejo completada';
    ELSE
        RAISE NOTICE 'Esquema ya está actualizado';
    END IF;

    -- Agregar FKs si no existen
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_name = 'repartidor_assignments'
          AND constraint_name = 'repartidor_assignments_created_by_employee_fkey'
    ) THEN
        ALTER TABLE repartidor_assignments
        ADD CONSTRAINT repartidor_assignments_created_by_employee_fkey
        FOREIGN KEY (created_by_employee_id) REFERENCES employees(id) ON DELETE RESTRICT;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_name = 'repartidor_assignments'
          AND constraint_name = 'repartidor_assignments_shift_fkey'
    ) THEN
        ALTER TABLE repartidor_assignments
        ADD CONSTRAINT repartidor_assignments_shift_fkey
        FOREIGN KEY (shift_id) REFERENCES shifts(id) ON DELETE SET NULL;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_name = 'repartidor_assignments'
          AND constraint_name = 'repartidor_assignments_repartidor_shift_fkey'
    ) THEN
        ALTER TABLE repartidor_assignments
        ADD CONSTRAINT repartidor_assignments_repartidor_shift_fkey
        FOREIGN KEY (repartidor_shift_id) REFERENCES shifts(id) ON DELETE SET NULL;
    END IF;

    -- Crear índices si no existen
    CREATE INDEX IF NOT EXISTS idx_repartidor_assignments_created_by ON repartidor_assignments(created_by_employee_id);
    CREATE INDEX IF NOT EXISTS idx_repartidor_assignments_shift ON repartidor_assignments(shift_id);
    CREATE INDEX IF NOT EXISTS idx_repartidor_assignments_repartidor_shift ON repartidor_assignments(repartidor_shift_id);
    CREATE INDEX IF NOT EXISTS idx_repartidor_assignments_status ON repartidor_assignments(status);
    CREATE INDEX IF NOT EXISTS idx_repartidor_assignments_needs_update ON repartidor_assignments(needs_update);

    RAISE NOTICE 'Migration 098 completada exitosamente';
END $$;
