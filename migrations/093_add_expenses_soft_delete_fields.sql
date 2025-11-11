-- Migration 093: Add soft delete and update tracking fields to expenses table
-- Permite marcar gastos como eliminados (soft delete) y trackear cambios

-- Add is_active column (default TRUE for existing records)
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;

-- Add deleted_at timestamp for soft delete tracking
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITH TIME ZONE;

-- Add updated_at timestamp for tracking modifications
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;

-- Create index for filtering active expenses
CREATE INDEX IF NOT EXISTS idx_expenses_is_active ON expenses(is_active);

-- Create index for deleted_at
CREATE INDEX IF NOT EXISTS idx_expenses_deleted_at ON expenses(deleted_at);

-- Add comment
COMMENT ON COLUMN expenses.is_active IS 'Soft delete flag: FALSE = deleted, TRUE = active';
COMMENT ON COLUMN expenses.deleted_at IS 'Timestamp when expense was soft deleted';
COMMENT ON COLUMN expenses.updated_at IS 'Timestamp of last modification';
