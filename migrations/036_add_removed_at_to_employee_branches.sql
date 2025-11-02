-- =============================================================================
-- Migration 036: Add removed_at column to employee_branches
-- =============================================================================
-- The employee_branches.js route expects a removed_at column for soft deletes
-- This tracks when an employee was unassigned from a branch

-- Add removed_at column for soft delete tracking
ALTER TABLE employee_branches ADD COLUMN IF NOT EXISTS removed_at TIMESTAMP WITH TIME ZONE;

-- Add comment explaining the column
COMMENT ON COLUMN employee_branches.removed_at IS 'Timestamp when employee was removed from branch (soft delete). NULL = still active.';

-- Create index for quick lookups of active relationships
CREATE INDEX IF NOT EXISTS idx_employee_branches_removed_at ON employee_branches(removed_at);
