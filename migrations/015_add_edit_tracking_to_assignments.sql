-- Migration: Add edit tracking columns to repartidor_assignments
-- Purpose: Track when assignments are edited (quantity/amount changes) and by whom for auditing
-- Date: 2026-01-07

-- Add edit tracking columns
ALTER TABLE repartidor_assignments
  ADD COLUMN IF NOT EXISTS was_edited BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS edit_reason TEXT,
  ADD COLUMN IF NOT EXISTS last_edited_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_edited_by_employee_id INTEGER REFERENCES employees(id),
  ADD COLUMN IF NOT EXISTS original_quantity_before_edit DECIMAL(10,3),
  ADD COLUMN IF NOT EXISTS original_amount_before_edit DECIMAL(12,2);

-- Add cancellation tracking columns
ALTER TABLE repartidor_assignments
  ADD COLUMN IF NOT EXISTS cancel_reason TEXT,
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_by_employee_id INTEGER REFERENCES employees(id);

-- Add index for finding edited assignments
CREATE INDEX IF NOT EXISTS idx_repartidor_assignments_was_edited
  ON repartidor_assignments(was_edited) WHERE was_edited = TRUE;

-- Add index for finding cancelled assignments
CREATE INDEX IF NOT EXISTS idx_repartidor_assignments_cancelled
  ON repartidor_assignments(status) WHERE status = 'cancelled';

COMMENT ON COLUMN repartidor_assignments.was_edited IS 'True if assignment was edited after creation';
COMMENT ON COLUMN repartidor_assignments.edit_reason IS 'Reason provided for the edit (mandatory)';
COMMENT ON COLUMN repartidor_assignments.last_edited_at IS 'Timestamp of last edit';
COMMENT ON COLUMN repartidor_assignments.last_edited_by_employee_id IS 'Employee who made the last edit';
COMMENT ON COLUMN repartidor_assignments.original_quantity_before_edit IS 'Original quantity before any edits';
COMMENT ON COLUMN repartidor_assignments.original_amount_before_edit IS 'Original amount before any edits';
COMMENT ON COLUMN repartidor_assignments.cancel_reason IS 'Reason provided for cancellation (mandatory)';
COMMENT ON COLUMN repartidor_assignments.cancelled_at IS 'Timestamp when cancelled';
COMMENT ON COLUMN repartidor_assignments.cancelled_by_employee_id IS 'Employee who cancelled the assignment';
