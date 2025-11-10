-- =====================================================
-- Migration: 082_add_offline_first_to_cash_cuts.sql
-- Descripción: Agregar columnas offline-first a cash_cuts para idempotencia
-- =====================================================
-- ✅ Completar soporte offline-first para la tabla cash_cuts
-- Permite retry sin duplicados usando global_id como clave de idempotencia
-- =====================================================

-- ========== CASH_CUTS TABLE ==========

-- Columnas offline-first
ALTER TABLE cash_cuts
ADD COLUMN IF NOT EXISTS global_id VARCHAR(255);

ALTER TABLE cash_cuts
ADD COLUMN IF NOT EXISTS terminal_id VARCHAR(100);

ALTER TABLE cash_cuts
ADD COLUMN IF NOT EXISTS local_op_seq INTEGER;

ALTER TABLE cash_cuts
ADD COLUMN IF NOT EXISTS device_event_raw BIGINT;

ALTER TABLE cash_cuts
ADD COLUMN IF NOT EXISTS created_local_utc TEXT;

-- Columnas de sincronización
ALTER TABLE cash_cuts
ADD COLUMN IF NOT EXISTS synced BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE cash_cuts
ADD COLUMN IF NOT EXISTS synced_at TIMESTAMPTZ DEFAULT NOW();

-- Índices para cash_cuts
CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_cuts_global_id_unique ON cash_cuts(global_id)
  WHERE global_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_cash_cuts_terminal_seq ON cash_cuts(terminal_id, local_op_seq)
  WHERE terminal_id IS NOT NULL AND local_op_seq IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_cash_cuts_synced ON cash_cuts(tenant_id, branch_id, synced)
  WHERE synced = FALSE;

-- Comentarios
COMMENT ON COLUMN cash_cuts.global_id IS 'UUID único para idempotencia - permite retry sin duplicados';
COMMENT ON COLUMN cash_cuts.terminal_id IS 'Identificador de la terminal que creó el corte';
COMMENT ON COLUMN cash_cuts.local_op_seq IS 'Secuencia local de operaciones';
COMMENT ON COLUMN cash_cuts.device_event_raw IS 'Timestamp raw del dispositivo';
COMMENT ON COLUMN cash_cuts.created_local_utc IS 'Timestamp ISO 8601 de creación';

-- ========== ACTUALIZAR REGISTROS EXISTENTES ==========
UPDATE cash_cuts
SET synced = TRUE, synced_at = NOW()
WHERE synced IS NULL;
