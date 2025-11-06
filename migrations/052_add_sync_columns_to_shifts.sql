-- =====================================================
-- Migration: 052_add_sync_columns_to_shifts.sql
-- Descripción: Agregar columnas de sincronización offline-first a tabla shifts
-- =====================================================
-- CRÍTICO: Desktop necesita trackear qué shifts han sido sincronizados
-- La tabla shifts existe pero le faltan: remote_id, synced, synced_at
-- =====================================================

-- ========== AGREGAR COLUMNAS DE SINCRONIZACIÓN ==========

-- remote_id: ID del registro en el servidor remoto (NULL en backend)
ALTER TABLE shifts
ADD COLUMN IF NOT EXISTS remote_id INTEGER;

-- synced: Indica si el registro ya fue sincronizado (siempre TRUE en backend)
ALTER TABLE shifts
ADD COLUMN IF NOT EXISTS synced BOOLEAN NOT NULL DEFAULT TRUE;

-- synced_at: Fecha y hora de la última sincronización exitosa
ALTER TABLE shifts
ADD COLUMN IF NOT EXISTS synced_at TIMESTAMPTZ DEFAULT NOW();

-- ========== ÍNDICES PARA MEJORAR PERFORMANCE DE SYNC ==========

-- Índice para búsquedas de shifts pendientes de sync (usado por Desktop)
CREATE INDEX IF NOT EXISTS idx_shifts_synced ON shifts(tenant_id, branch_id, synced)
  WHERE synced = FALSE;

-- ========== COMENTARIOS PARA DOCUMENTACIÓN ==========
COMMENT ON COLUMN shifts.remote_id IS 'No usado en backend - Desktop lo usa para almacenar el ID del servidor';
COMMENT ON COLUMN shifts.synced IS 'Siempre TRUE en backend - Desktop usa esto para trackear qué shifts están sincronizados';
COMMENT ON COLUMN shifts.synced_at IS 'Timestamp de la última sincronización exitosa con el backend';

-- ========== ACTUALIZAR REGISTROS EXISTENTES ==========
-- Marcar todos los shifts existentes como sincronizados (son datos del backend)
UPDATE shifts
SET
  synced = TRUE,
  synced_at = NOW()
WHERE synced IS NULL OR synced_at IS NULL;
