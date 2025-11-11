-- Migration 094: Optimize repartidor_assignments (3NF - Remove redundancy)
-- ==============================================================================
-- OBJETIVO: Eliminar campos redundantes y agregar trazabilidad completa
-- - Renombrar cantidad_asignada → assigned_quantity
-- - Renombrar monto_asignado → assigned_amount
-- - Agregar unit_price (para calcular devoluciones)
-- - Agregar created_by_employee_id (cajero que asignó)
-- - Agregar shift_id (turno del cajero)
-- - Renombrar turno_repartidor_id → repartidor_shift_id
-- - ELIMINAR cantidad_devuelta (se calcula desde returns)
-- - ELIMINAR monto_devuelto (se calcula desde returns)
-- - ELIMINAR remote_id (se usa global_id)
-- - Renombrar estado → status
-- ==============================================================================

-- 1. Agregar nuevas columnas
ALTER TABLE repartidor_assignments ADD COLUMN IF NOT EXISTS assigned_quantity NUMERIC(10,2);
ALTER TABLE repartidor_assignments ADD COLUMN IF NOT EXISTS assigned_amount NUMERIC(10,2);
ALTER TABLE repartidor_assignments ADD COLUMN IF NOT EXISTS unit_price NUMERIC(10,2);
ALTER TABLE repartidor_assignments ADD COLUMN IF NOT EXISTS created_by_employee_id INTEGER REFERENCES employees(id) ON DELETE RESTRICT;
ALTER TABLE repartidor_assignments ADD COLUMN IF NOT EXISTS shift_id INTEGER REFERENCES shifts(id) ON DELETE SET NULL;
ALTER TABLE repartidor_assignments ADD COLUMN IF NOT EXISTS repartidor_shift_id INTEGER REFERENCES shifts(id) ON DELETE SET NULL;
ALTER TABLE repartidor_assignments ADD COLUMN IF NOT EXISTS status VARCHAR(30) DEFAULT 'pending';
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
WHERE status = 'pending' AND estado IS NOT NULL;

-- 3. Calcular unit_price de los registros existentes
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

-- 6. Crear índices para nuevas columnas
CREATE INDEX IF NOT EXISTS idx_repartidor_assignments_created_by ON repartidor_assignments(created_by_employee_id);
CREATE INDEX IF NOT EXISTS idx_repartidor_assignments_shift ON repartidor_assignments(shift_id);
CREATE INDEX IF NOT EXISTS idx_repartidor_assignments_repartidor_shift ON repartidor_assignments(repartidor_shift_id);
CREATE INDEX IF NOT EXISTS idx_repartidor_assignments_status ON repartidor_assignments(status);
CREATE INDEX IF NOT EXISTS idx_repartidor_assignments_needs_update ON repartidor_assignments(needs_update);

-- 7. Constraint UNIQUE en sale_id (se maneja en migration 096 de forma segura)
-- Removido de aquí porque puede fallar si hay duplicados en producción
-- Ver: 096_fix_repartidor_assignments_constraint.sql

-- 8. Comentarios de documentación
COMMENT ON COLUMN repartidor_assignments.assigned_quantity IS 'Cantidad ORIGINAL asignada (no cambia, readonly)';
COMMENT ON COLUMN repartidor_assignments.assigned_amount IS 'Monto ORIGINAL asignado (no cambia, readonly)';
COMMENT ON COLUMN repartidor_assignments.unit_price IS 'Precio unitario para calcular devoluciones';
COMMENT ON COLUMN repartidor_assignments.created_by_employee_id IS 'Cajero que creó la asignación';
COMMENT ON COLUMN repartidor_assignments.shift_id IS 'Turno del cajero al crear';
COMMENT ON COLUMN repartidor_assignments.repartidor_shift_id IS 'Turno del repartidor (puede ser diferente)';
COMMENT ON COLUMN repartidor_assignments.status IS 'pending | in_progress | liquidated | cancelled';
COMMENT ON COLUMN repartidor_assignments.needs_update IS 'TRUE si hay cambios pendientes de sync desde Desktop';
COMMENT ON COLUMN repartidor_assignments.last_modified_local_utc IS 'Timestamp de última modificación en Desktop';
