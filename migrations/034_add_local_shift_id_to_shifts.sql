-- =============================================================================
-- Migration 034: Add local_shift_id to shifts table
-- =============================================================================
-- Adds support for offline-first shift tracking using local IDs from Desktop

-- Add local_shift_id column for offline tracking
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS local_shift_id INTEGER UNIQUE;

-- Add comment explaining the column
COMMENT ON COLUMN shifts.local_shift_id IS 'Local shift ID from Desktop app - used for offline-first sync, mapped to server ID when shift is synced';

-- Create index for quick lookups
CREATE INDEX IF NOT EXISTS idx_shifts_local_shift_id ON shifts(local_shift_id);
CREATE INDEX IF NOT EXISTS idx_shifts_tenant_branch_employee ON shifts(tenant_id, branch_id, employee_id);
CREATE INDEX IF NOT EXISTS idx_shifts_start_time ON shifts(start_time DESC);
