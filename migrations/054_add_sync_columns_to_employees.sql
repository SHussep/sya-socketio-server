-- =====================================================
-- Migration: 054_add_sync_columns_to_employees.sql
-- Descripción: Agregar columnas de sincronización para employees
-- =====================================================
-- CRÍTICO: Desktop necesita sincronizar empleados con tracking de cambios
-- La tabla employees necesita columnas para trackear:
-- - Estado de sincronización (RemoteId, Synced, SyncedAt)
-- - Cambios pendientes (NeedsUpdate, MarkedForDeletion)
-- - Sincronización de contraseñas (PasswordNeedsSync)
-- =====================================================

-- ========== COLUMNAS DE SINCRONIZACIÓN ==========

-- remote_id: ID del registro en el servidor remoto (NULL en backend)
ALTER TABLE employees
ADD COLUMN IF NOT EXISTS remote_id INTEGER;

-- synced: Indica si el registro ya fue sincronizado (siempre TRUE en backend)
ALTER TABLE employees
ADD COLUMN IF NOT EXISTS synced BOOLEAN NOT NULL DEFAULT TRUE;

-- synced_at: Fecha y hora de la última sincronización exitosa
ALTER TABLE employees
ADD COLUMN IF NOT EXISTS synced_at TIMESTAMPTZ DEFAULT NOW();

-- ========== COLUMNAS DE TRACKING DE CAMBIOS ==========

-- needs_update: Indica que el empleado tiene cambios pendientes de sincronizar
ALTER TABLE employees
ADD COLUMN IF NOT EXISTS needs_update BOOLEAN NOT NULL DEFAULT FALSE;

-- marked_for_deletion: Indica que el empleado debe eliminarse en la próxima sincronización
ALTER TABLE employees
ADD COLUMN IF NOT EXISTS marked_for_deletion BOOLEAN NOT NULL DEFAULT FALSE;

-- password_needs_sync: Indica que la contraseña del empleado cambió y debe sincronizarse
ALTER TABLE employees
ADD COLUMN IF NOT EXISTS password_needs_sync BOOLEAN NOT NULL DEFAULT FALSE;

-- ========== ÍNDICES ==========

-- Búsqueda de empleados pendientes de sincronización (usado por Desktop)
CREATE INDEX IF NOT EXISTS idx_employees_synced ON employees(tenant_id, synced)
  WHERE synced = FALSE;

-- Búsqueda de empleados con cambios pendientes
CREATE INDEX IF NOT EXISTS idx_employees_needs_update ON employees(tenant_id, needs_update)
  WHERE needs_update = TRUE;

-- Búsqueda de empleados marcados para eliminación
CREATE INDEX IF NOT EXISTS idx_employees_marked_for_deletion ON employees(tenant_id, marked_for_deletion)
  WHERE marked_for_deletion = TRUE;

-- Búsqueda de empleados con contraseñas pendientes de sincronizar
CREATE INDEX IF NOT EXISTS idx_employees_password_needs_sync ON employees(tenant_id, password_needs_sync)
  WHERE password_needs_sync = TRUE;

-- ========== COMENTARIOS PARA DOCUMENTACIÓN ==========
COMMENT ON COLUMN employees.remote_id IS 'No usado en backend - Desktop lo usa para almacenar el ID del servidor';
COMMENT ON COLUMN employees.synced IS 'Siempre TRUE en backend - Desktop usa esto para trackear qué empleados están sincronizados';
COMMENT ON COLUMN employees.synced_at IS 'Timestamp de la última sincronización exitosa con el backend';
COMMENT ON COLUMN employees.needs_update IS 'TRUE si el empleado tiene cambios pendientes de sincronizar al backend';
COMMENT ON COLUMN employees.marked_for_deletion IS 'TRUE si el empleado debe eliminarse en la próxima sincronización';
COMMENT ON COLUMN employees.password_needs_sync IS 'TRUE si la contraseña del empleado cambió y debe sincronizarse';

-- ========== ACTUALIZAR REGISTROS EXISTENTES ==========
-- Marcar todos los empleados existentes como sincronizados (son datos del backend)
UPDATE employees
SET
  synced = TRUE,
  synced_at = NOW(),
  needs_update = FALSE,
  marked_for_deletion = FALSE,
  password_needs_sync = FALSE
WHERE synced IS NULL OR synced_at IS NULL;
