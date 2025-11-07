-- =====================================================
-- Migration: 066_add_offline_first_to_repartidor_assignments.sql
-- Descripción: Agregar campos offline-first a repartidor_assignments
-- =====================================================

-- ✅ Agregar columnas offline-first
ALTER TABLE repartidor_assignments
ADD COLUMN IF NOT EXISTS global_id uuid,
ADD COLUMN IF NOT EXISTS terminal_id uuid,
ADD COLUMN IF NOT EXISTS local_op_seq int,
ADD COLUMN IF NOT EXISTS created_local_utc timestamptz,
ADD COLUMN IF NOT EXISTS device_event_raw bigint;

-- ✅ UNIQUE constraint en global_id
CREATE UNIQUE INDEX IF NOT EXISTS uq_repartidor_assignments_global_id
    ON repartidor_assignments (global_id)
    WHERE global_id IS NOT NULL;

-- ✅ Índice para búsquedas por GlobalId
CREATE INDEX IF NOT EXISTS idx_repartidor_assignments_global_id
    ON repartidor_assignments (global_id)
    WHERE global_id IS NOT NULL;

-- ✅ Índice para TerminalId + LocalOpSeq (ordenamiento determinista)
CREATE INDEX IF NOT EXISTS idx_repartidor_assignments_terminal_seq
    ON repartidor_assignments (terminal_id, local_op_seq)
    WHERE terminal_id IS NOT NULL AND local_op_seq IS NOT NULL;

-- ✅ Comentarios
COMMENT ON COLUMN repartidor_assignments.global_id IS 'UUID único para idempotencia - previene duplicados';
COMMENT ON COLUMN repartidor_assignments.terminal_id IS 'UUID de la terminal que creó la asignación';
COMMENT ON COLUMN repartidor_assignments.local_op_seq IS 'Secuencia local de operaciones';
COMMENT ON COLUMN repartidor_assignments.created_local_utc IS 'Timestamp de creación en UTC desde el dispositivo';
COMMENT ON COLUMN repartidor_assignments.device_event_raw IS 'Timestamp raw del dispositivo (epoch_ms o .NET ticks)';
