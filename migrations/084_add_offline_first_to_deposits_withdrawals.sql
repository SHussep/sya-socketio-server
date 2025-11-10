-- =====================================================
-- Migration: 056_add_sync_columns_to_cash_management.sql
-- Descripción: Agregar columnas offline-first a deposits y withdrawals
-- =====================================================
-- Completar soporte offline-first para las tablas de cash management
-- (deposits, withdrawals) que el Desktop sincroniza
-- =====================================================

-- ========== DEPOSITS TABLE ==========

-- Columnas offline-first
ALTER TABLE deposits
ADD COLUMN IF NOT EXISTS global_id VARCHAR(255);

ALTER TABLE deposits
ADD COLUMN IF NOT EXISTS terminal_id VARCHAR(100);

ALTER TABLE deposits
ADD COLUMN IF NOT EXISTS local_op_seq INTEGER;

ALTER TABLE deposits
ADD COLUMN IF NOT EXISTS device_event_raw BIGINT;

ALTER TABLE deposits
ADD COLUMN IF NOT EXISTS created_local_utc TEXT;

-- Columnas de sincronización (remote_id NO es necesario - global_id es suficiente para idempotencia)
ALTER TABLE deposits
ADD COLUMN IF NOT EXISTS synced BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE deposits
ADD COLUMN IF NOT EXISTS synced_at TIMESTAMPTZ DEFAULT NOW();

-- Índices para deposits
CREATE UNIQUE INDEX IF NOT EXISTS idx_deposits_global_id_unique ON deposits(global_id)
  WHERE global_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_deposits_terminal_seq ON deposits(terminal_id, local_op_seq)
  WHERE terminal_id IS NOT NULL AND local_op_seq IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_deposits_synced ON deposits(tenant_id, branch_id, synced)
  WHERE synced = FALSE;

-- Comentarios
COMMENT ON COLUMN deposits.global_id IS 'UUID único para idempotencia';
COMMENT ON COLUMN deposits.terminal_id IS 'Identificador de la terminal';
COMMENT ON COLUMN deposits.local_op_seq IS 'Secuencia local de operaciones';
COMMENT ON COLUMN deposits.device_event_raw IS 'Timestamp raw del dispositivo';
COMMENT ON COLUMN deposits.created_local_utc IS 'Timestamp ISO 8601 de creación';

-- ========== WITHDRAWALS TABLE ==========

-- Columnas offline-first
ALTER TABLE withdrawals
ADD COLUMN IF NOT EXISTS global_id VARCHAR(255);

ALTER TABLE withdrawals
ADD COLUMN IF NOT EXISTS terminal_id VARCHAR(100);

ALTER TABLE withdrawals
ADD COLUMN IF NOT EXISTS local_op_seq INTEGER;

ALTER TABLE withdrawals
ADD COLUMN IF NOT EXISTS device_event_raw BIGINT;

ALTER TABLE withdrawals
ADD COLUMN IF NOT EXISTS created_local_utc TEXT;

-- Columnas de sincronización (remote_id NO es necesario - global_id es suficiente para idempotencia)
ALTER TABLE withdrawals
ADD COLUMN IF NOT EXISTS synced BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE withdrawals
ADD COLUMN IF NOT EXISTS synced_at TIMESTAMPTZ DEFAULT NOW();

-- Índices para withdrawals
CREATE UNIQUE INDEX IF NOT EXISTS idx_withdrawals_global_id_unique ON withdrawals(global_id)
  WHERE global_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_withdrawals_terminal_seq ON withdrawals(terminal_id, local_op_seq)
  WHERE terminal_id IS NOT NULL AND local_op_seq IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_withdrawals_synced ON withdrawals(tenant_id, branch_id, synced)
  WHERE synced = FALSE;

-- Comentarios
COMMENT ON COLUMN withdrawals.global_id IS 'UUID único para idempotencia';
COMMENT ON COLUMN withdrawals.terminal_id IS 'Identificador de la terminal';
COMMENT ON COLUMN withdrawals.local_op_seq IS 'Secuencia local de operaciones';
COMMENT ON COLUMN withdrawals.device_event_raw IS 'Timestamp raw del dispositivo';
COMMENT ON COLUMN withdrawals.created_local_utc IS 'Timestamp ISO 8601 de creación';

-- ========== ACTUALIZAR REGISTROS EXISTENTES ==========
UPDATE deposits
SET synced = TRUE, synced_at = NOW()
WHERE synced IS NULL;

UPDATE withdrawals
SET synced = TRUE, synced_at = NOW()
WHERE synced IS NULL;
