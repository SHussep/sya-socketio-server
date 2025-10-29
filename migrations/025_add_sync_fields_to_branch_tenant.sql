-- ═══════════════════════════════════════════════════════════════════════════
-- MIGRATION 025: Add sync fields to Branch and Tenant tables
-- Purpose: Add RemoteId, Synced, SyncedAt to branches and tenants tables
--          for complete synchronization tracking across all entities
-- Date: 2025-10-29
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- ADD SYNC FIELDS TO BRANCHES TABLE
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE branches
ADD COLUMN IF NOT EXISTS remote_id INTEGER,
ADD COLUMN IF NOT EXISTS synced BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS synced_at TIMESTAMP WITH TIME ZONE;

-- Create indices for synced status queries
CREATE INDEX IF NOT EXISTS idx_branches_synced ON branches(synced);
CREATE INDEX IF NOT EXISTS idx_branches_remote_id ON branches(remote_id);
CREATE INDEX IF NOT EXISTS idx_branches_tenant_synced ON branches(tenant_id, synced);

COMMENT ON COLUMN branches.remote_id IS 'ID del registro en el servidor remoto (Desktop SQLite)';
COMMENT ON COLUMN branches.synced IS 'Indica si este registro fue sincronizado';
COMMENT ON COLUMN branches.synced_at IS 'Timestamp de la última sincronización exitosa';

-- ═══════════════════════════════════════════════════════════════════════════
-- ADD SYNC FIELDS TO TENANTS TABLE
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE tenants
ADD COLUMN IF NOT EXISTS remote_id INTEGER,
ADD COLUMN IF NOT EXISTS synced BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS synced_at TIMESTAMP WITH TIME ZONE;

-- Create indices for synced status queries
CREATE INDEX IF NOT EXISTS idx_tenants_synced ON tenants(synced);
CREATE INDEX IF NOT EXISTS idx_tenants_remote_id ON tenants(remote_id);

COMMENT ON COLUMN tenants.remote_id IS 'ID del registro en el servidor remoto (Desktop SQLite)';
COMMENT ON COLUMN tenants.synced IS 'Indica si este registro fue sincronizado';
COMMENT ON COLUMN tenants.synced_at IS 'Timestamp de la última sincronización exitosa';

COMMIT;
