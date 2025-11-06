-- =====================================================
-- Migration: 053_add_sync_columns_to_expenses.sql
-- Descripción: Agregar columnas offline-first completas a tabla expenses
-- =====================================================
-- CRÍTICO: Desktop necesita sincronizar gastos con arquitectura offline-first
-- La tabla expenses necesita 8 columnas: GlobalId, TerminalId, LocalOpSeq,
-- DeviceEventRaw, CreatedLocalUtc, RemoteId, Synced, SyncedAt
-- =====================================================

-- ========== COLUMNAS OFFLINE-FIRST ==========

-- GlobalId: UUID único para idempotencia (prevenir duplicados)
ALTER TABLE expenses
ADD COLUMN IF NOT EXISTS global_id VARCHAR(255);

-- TerminalId: Identificador de la terminal que creó el registro
ALTER TABLE expenses
ADD COLUMN IF NOT EXISTS terminal_id VARCHAR(100);

-- LocalOpSeq: Secuencia local de operaciones para ordenamiento determinista
ALTER TABLE expenses
ADD COLUMN IF NOT EXISTS local_op_seq INTEGER;

-- DeviceEventRaw: Timestamp raw del dispositivo (epoch_ms o .NET ticks)
ALTER TABLE expenses
ADD COLUMN IF NOT EXISTS device_event_raw BIGINT;

-- CreatedLocalUtc: Timestamp ISO 8601 de creación en el dispositivo
ALTER TABLE expenses
ADD COLUMN IF NOT EXISTS created_local_utc TEXT;

-- ========== COLUMNAS DE SINCRONIZACIÓN ==========

-- remote_id: ID del registro en el servidor remoto (NULL en backend)
ALTER TABLE expenses
ADD COLUMN IF NOT EXISTS remote_id INTEGER;

-- synced: Indica si el registro ya fue sincronizado (siempre TRUE en backend)
ALTER TABLE expenses
ADD COLUMN IF NOT EXISTS synced BOOLEAN NOT NULL DEFAULT TRUE;

-- synced_at: Fecha y hora de la última sincronización exitosa
ALTER TABLE expenses
ADD COLUMN IF NOT EXISTS synced_at TIMESTAMPTZ DEFAULT NOW();

-- ========== ÍNDICES ==========

-- GlobalId UNIQUE para prevenir duplicados (idempotencia)
CREATE UNIQUE INDEX IF NOT EXISTS idx_expenses_global_id_unique ON expenses(global_id)
  WHERE global_id IS NOT NULL;

-- Búsqueda rápida de GlobalId
CREATE INDEX IF NOT EXISTS idx_expenses_global_id ON expenses(global_id)
  WHERE global_id IS NOT NULL;

-- TerminalId + LocalOpSeq para ordenamiento determinista en sync
CREATE INDEX IF NOT EXISTS idx_expenses_terminal_seq ON expenses(terminal_id, local_op_seq)
  WHERE terminal_id IS NOT NULL AND local_op_seq IS NOT NULL;

-- Búsqueda de registros pendientes de sync (usado por Desktop)
CREATE INDEX IF NOT EXISTS idx_expenses_synced ON expenses(tenant_id, branch_id, synced)
  WHERE synced = FALSE;

-- ========== COMENTARIOS PARA DOCUMENTACIÓN ==========
COMMENT ON COLUMN expenses.global_id IS 'UUID único para idempotencia - previene duplicados en sincronización offline';
COMMENT ON COLUMN expenses.terminal_id IS 'Identificador de la terminal que creó el gasto (ej: TERM001)';
COMMENT ON COLUMN expenses.local_op_seq IS 'Secuencia local de operaciones para ordenamiento determinista';
COMMENT ON COLUMN expenses.device_event_raw IS 'Timestamp raw del dispositivo (epoch_ms o .NET ticks)';
COMMENT ON COLUMN expenses.created_local_utc IS 'Timestamp ISO 8601 de creación en UTC desde el dispositivo';
COMMENT ON COLUMN expenses.remote_id IS 'No usado en backend - Desktop lo usa para almacenar el ID del servidor';
COMMENT ON COLUMN expenses.synced IS 'Siempre TRUE en backend - Desktop usa esto para trackear qué gastos están sincronizados';
COMMENT ON COLUMN expenses.synced_at IS 'Timestamp de la última sincronización exitosa con el backend';

-- ========== ACTUALIZAR REGISTROS EXISTENTES ==========
-- Marcar todos los gastos existentes como sincronizados (son datos del backend)
-- No podemos generar GlobalId retroactivamente - se generará en próximas operaciones
UPDATE expenses
SET
  synced = TRUE,
  synced_at = NOW()
WHERE synced IS NULL OR synced_at IS NULL;
