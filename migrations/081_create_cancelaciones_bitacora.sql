-- =====================================================
-- Migration 080: Create cancelaciones_bitacora table
-- Purpose: Track all sale cancellations with offline-first sync support
-- Author: System
-- Date: 2025-01-09
-- =====================================================

-- Create cancelaciones_bitacora table for tracking cancellations
CREATE TABLE IF NOT EXISTS cancelaciones_bitacora (
    id SERIAL PRIMARY KEY,

    -- Offline-first sync fields (idempotency)
    global_id VARCHAR(255) UNIQUE NOT NULL, -- UUID for idempotency
    terminal_id VARCHAR(100) NOT NULL, -- Terminal identifier
    local_op_seq INTEGER NOT NULL, -- Local operation sequence for deterministic ordering
    created_local_utc TEXT NOT NULL, -- ISO 8601 timestamp from device
    synced BOOLEAN DEFAULT FALSE, -- Sync status flag
    synced_at_raw BIGINT, -- Sync timestamp (UnixTimeMilliseconds)
    remote_id INTEGER, -- Reference to remote system if applicable

    -- Foreign keys
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    id_turno INTEGER NOT NULL, -- Reference to shift
    id_empleado INTEGER NOT NULL, -- Reference to employee

    -- Cancellation details
    fecha TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    id_venta INTEGER, -- Full sale cancelled (nullable)
    id_venta_detalle INTEGER, -- Sale line item deleted (nullable)
    id_producto BIGINT, -- Product ID if applicable
    descripcion VARCHAR(500), -- Product description
    cantidad NUMERIC(10, 3) DEFAULT 0, -- Quantity cancelled
    peso_kg NUMERIC(10, 3), -- Weight in kg if applicable

    -- Cancellation reason (normalized)
    motivo VARCHAR(500), -- "Eliminado de ticket", "Venta cancelada", "Error de captura", etc.
    razon_id INTEGER REFERENCES cancelacion_razones(id), -- Normalized cancellation reason (FK)
    otra_razon TEXT, -- Only filled if razon_id is "Otra" (free text explanation)

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Create indices for performance
CREATE INDEX IF NOT EXISTS idx_cancelaciones_global_id ON cancelaciones_bitacora(global_id);
CREATE INDEX IF NOT EXISTS idx_cancelaciones_terminal_seq ON cancelaciones_bitacora(terminal_id, local_op_seq);
CREATE INDEX IF NOT EXISTS idx_cancelaciones_synced ON cancelaciones_bitacora(tenant_id, branch_id, synced) WHERE synced = FALSE;
CREATE INDEX IF NOT EXISTS idx_cancelaciones_fecha ON cancelaciones_bitacora(tenant_id, branch_id, fecha DESC);
CREATE INDEX IF NOT EXISTS idx_cancelaciones_empleado ON cancelaciones_bitacora(id_empleado, fecha DESC);
CREATE INDEX IF NOT EXISTS idx_cancelaciones_turno ON cancelaciones_bitacora(id_turno);
CREATE INDEX IF NOT EXISTS idx_cancelaciones_venta ON cancelaciones_bitacora(id_venta) WHERE id_venta IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cancelaciones_razon ON cancelaciones_bitacora(razon_id) WHERE razon_id IS NOT NULL;

-- Add trigger for updated_at
CREATE OR REPLACE FUNCTION update_cancelaciones_bitacora_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_cancelaciones_bitacora_updated_at
    BEFORE UPDATE ON cancelaciones_bitacora
    FOR EACH ROW
    EXECUTE FUNCTION update_cancelaciones_bitacora_updated_at();

-- Add comment to table
COMMENT ON TABLE cancelaciones_bitacora IS 'Tracks all sale cancellations with offline-first synchronization support';
COMMENT ON COLUMN cancelaciones_bitacora.global_id IS 'UUID for idempotent sync - prevents duplicate inserts';
COMMENT ON COLUMN cancelaciones_bitacora.terminal_id IS 'Terminal/POS identifier that created the cancellation';
COMMENT ON COLUMN cancelaciones_bitacora.local_op_seq IS 'Local operation sequence for deterministic ordering';
COMMENT ON COLUMN cancelaciones_bitacora.razon_id IS 'Foreign key to cancelacion_razones - normalized cancellation reason for analysis';
COMMENT ON COLUMN cancelaciones_bitacora.otra_razon IS 'Free text explanation - only required when razon_id points to "Otra" reason';
