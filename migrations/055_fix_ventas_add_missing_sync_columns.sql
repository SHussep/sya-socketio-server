-- =====================================================
-- Migration: 055_fix_ventas_add_missing_sync_columns.sql
-- Descripción: Agregar columnas offline-first faltantes a tabla ventas
-- =====================================================
-- CRÍTICO: La tabla ventas (creada en migration 046) tiene remote_id, synced, synced_at
-- pero le faltan las columnas necesarias para arquitectura offline-first completa:
-- - global_id (UUID para idempotencia)
-- - terminal_id (identificador de terminal)
-- - local_op_seq (secuencia de operaciones)
-- - device_event_raw (ya existe como fecha_venta_raw, NO duplicar)
-- - created_local_utc (timestamp ISO 8601)
-- =====================================================

-- ========== COLUMNAS OFFLINE-FIRST FALTANTES ==========

-- global_id: UUID único para idempotencia (prevenir duplicados)
ALTER TABLE ventas
ADD COLUMN IF NOT EXISTS global_id VARCHAR(255);

-- terminal_id: Identificador de la terminal que creó la venta
ALTER TABLE ventas
ADD COLUMN IF NOT EXISTS terminal_id VARCHAR(100);

-- local_op_seq: Secuencia local de operaciones para ordenamiento determinista
ALTER TABLE ventas
ADD COLUMN IF NOT EXISTS local_op_seq INTEGER;

-- created_local_utc: Timestamp ISO 8601 de creación en el dispositivo
ALTER TABLE ventas
ADD COLUMN IF NOT EXISTS created_local_utc TEXT;

-- NOTA: device_event_raw NO se agrega porque ya existe como fecha_venta_raw

-- ========== ÍNDICES ==========

-- GlobalId UNIQUE para prevenir duplicados (idempotencia)
CREATE UNIQUE INDEX IF NOT EXISTS idx_ventas_global_id_unique ON ventas(global_id)
  WHERE global_id IS NOT NULL;

-- Búsqueda rápida de GlobalId
CREATE INDEX IF NOT EXISTS idx_ventas_global_id ON ventas(global_id)
  WHERE global_id IS NOT NULL;

-- TerminalId + LocalOpSeq para ordenamiento determinista en sync
CREATE INDEX IF NOT EXISTS idx_ventas_terminal_seq ON ventas(terminal_id, local_op_seq)
  WHERE terminal_id IS NOT NULL AND local_op_seq IS NOT NULL;

-- Búsqueda de ventas pendientes de sync (usado por Desktop)
CREATE INDEX IF NOT EXISTS idx_ventas_synced ON ventas(tenant_id, branch_id, synced)
  WHERE synced = FALSE;

-- ========== COMENTARIOS PARA DOCUMENTACIÓN ==========
COMMENT ON COLUMN ventas.global_id IS 'UUID único para idempotencia - previene duplicados en sincronización offline';
COMMENT ON COLUMN ventas.terminal_id IS 'Identificador de la terminal que creó la venta (ej: TERM001)';
COMMENT ON COLUMN ventas.local_op_seq IS 'Secuencia local de operaciones para ordenamiento determinista';
COMMENT ON COLUMN ventas.created_local_utc IS 'Timestamp ISO 8601 de creación en UTC desde el dispositivo';

-- NOTA: ventas.fecha_venta_raw ya existe y sirve como device_event_raw
COMMENT ON COLUMN ventas.fecha_venta_raw IS 'Timestamp raw desde Desktop (epoch_ms) - equivalente a DeviceEventRaw';

-- ========== ACTUALIZAR REGISTROS EXISTENTES ==========
-- No podemos generar GlobalId retroactivamente - se generará en próximas operaciones
-- Los registros existentes ya están marcados como sincronizados (migration 046)
