-- ============================================================================
-- MIGRACIÓN: Renombrar repartidor_shift_cash_snapshot → shift_cash_snapshot
-- ============================================================================
-- Propósito: Hacer la tabla genérica para TODOS los roles (no solo repartidores)
-- ============================================================================

-- 1. Renombrar la tabla
ALTER TABLE IF EXISTS repartidor_shift_cash_snapshot RENAME TO shift_cash_snapshot;

-- 2. Renombrar el constraint UNIQUE
ALTER TABLE IF EXISTS shift_cash_snapshot
  DROP CONSTRAINT IF EXISTS repartidor_shift_cash_snapshot_repartidor_shift_id_key;

ALTER TABLE IF EXISTS shift_cash_snapshot
  DROP CONSTRAINT IF EXISTS unique_snapshot_per_shift;

ALTER TABLE IF EXISTS shift_cash_snapshot
  ADD CONSTRAINT unique_snapshot_per_shift UNIQUE(repartidor_shift_id);

-- 3. Renombrar la columna repartidor_shift_id → shift_id
ALTER TABLE IF EXISTS shift_cash_snapshot
  RENAME COLUMN repartidor_shift_id TO shift_id;

-- 4. Actualizar constraint UNIQUE para la nueva columna
ALTER TABLE IF EXISTS shift_cash_snapshot
  DROP CONSTRAINT IF EXISTS unique_snapshot_per_shift;

ALTER TABLE IF EXISTS shift_cash_snapshot
  ADD CONSTRAINT unique_snapshot_per_shift UNIQUE(shift_id);

-- 5. Agregar campo employee_role para distinguir tipo de usuario
ALTER TABLE IF EXISTS shift_cash_snapshot
  ADD COLUMN IF NOT EXISTS employee_role VARCHAR(50);

-- 6. Rellenar employee_role basado en el rol del empleado
UPDATE shift_cash_snapshot sc
SET employee_role = r.name
FROM shifts s
INNER JOIN employees e ON s.employee_id = e.id
INNER JOIN roles r ON e.role_id = r.id
WHERE sc.shift_id = s.id
  AND sc.employee_role IS NULL;

-- 7. Hacer employee_role NOT NULL después de rellenar
ALTER TABLE IF EXISTS shift_cash_snapshot
  ALTER COLUMN employee_role SET NOT NULL;

-- 8. Renombrar índices
DROP INDEX IF EXISTS idx_cash_snapshot_shift;
DROP INDEX IF EXISTS idx_cash_snapshot_employee;
DROP INDEX IF EXISTS idx_cash_snapshot_branch;
DROP INDEX IF EXISTS idx_cash_snapshot_needs_recalc;
DROP INDEX IF EXISTS idx_cash_snapshot_needs_update;
DROP INDEX IF EXISTS idx_cash_snapshot_needs_deletion;
DROP INDEX IF EXISTS idx_cash_snapshot_global_id;
DROP INDEX IF EXISTS idx_cash_snapshot_updated_at;

-- Recrear índices con nuevos nombres
CREATE INDEX IF NOT EXISTS idx_shift_cash_snapshot_shift ON shift_cash_snapshot(shift_id);
CREATE INDEX IF NOT EXISTS idx_shift_cash_snapshot_employee ON shift_cash_snapshot(employee_id);
CREATE INDEX IF NOT EXISTS idx_shift_cash_snapshot_branch ON shift_cash_snapshot(branch_id, tenant_id);
CREATE INDEX IF NOT EXISTS idx_shift_cash_snapshot_role ON shift_cash_snapshot(employee_role);
CREATE INDEX IF NOT EXISTS idx_shift_cash_snapshot_needs_recalc ON shift_cash_snapshot(needs_recalculation) WHERE needs_recalculation = TRUE;
CREATE INDEX IF NOT EXISTS idx_shift_cash_snapshot_needs_update ON shift_cash_snapshot(needs_update) WHERE needs_update = TRUE;
CREATE INDEX IF NOT EXISTS idx_shift_cash_snapshot_needs_deletion ON shift_cash_snapshot(needs_deletion) WHERE needs_deletion = TRUE;
CREATE INDEX IF NOT EXISTS idx_shift_cash_snapshot_global_id ON shift_cash_snapshot(global_id) WHERE global_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_shift_cash_snapshot_updated_at ON shift_cash_snapshot(updated_at DESC);

-- 9. Actualizar funciones para usar nuevo nombre de tabla
DROP FUNCTION IF EXISTS recalculate_repartidor_cash_snapshot(INTEGER);
DROP FUNCTION IF EXISTS update_repartidor_cash_delivered(INTEGER, DECIMAL);

-- 10. Comentarios actualizados
COMMENT ON TABLE shift_cash_snapshot IS 'Snapshot incremental del estado de caja para TODOS los turnos (repartidores, cajeros, admins). Soporta sincronización offline-first.';
COMMENT ON COLUMN shift_cash_snapshot.employee_role IS 'Rol del empleado (repartidor, cajero, administrador, etc.) del turno asociado';
COMMENT ON COLUMN shift_cash_snapshot.shift_id IS 'ID del turno asociado (antes repartidor_shift_id)';

COMMENT ON COLUMN shift_cash_snapshot.total_assigned_amount IS 'Solo para repartidores: Total asignado en pesos';
COMMENT ON COLUMN shift_cash_snapshot.total_assigned_quantity IS 'Solo para repartidores: Total asignado en kg';
COMMENT ON COLUMN shift_cash_snapshot.total_returned_amount IS 'Solo para repartidores: Total devuelto en pesos';
COMMENT ON COLUMN shift_cash_snapshot.total_returned_quantity IS 'Solo para repartidores: Total devuelto en kg';
COMMENT ON COLUMN shift_cash_snapshot.net_amount_to_deliver IS 'Solo para repartidores: Dinero neto a entregar';
COMMENT ON COLUMN shift_cash_snapshot.actual_cash_delivered IS 'Solo para repartidores: Dinero realmente entregado';
COMMENT ON COLUMN shift_cash_snapshot.cash_difference IS 'Solo para repartidores: Sobrante/Faltante';

-- ============================================================================
-- FIN DE MIGRACIÓN
-- ============================================================================
