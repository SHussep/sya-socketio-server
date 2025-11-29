-- =====================================================
-- Migration: Add status column to repartidor_returns
-- Purpose: Support draft/confirmed/deleted states
-- =====================================================

-- Add status column with default 'confirmed' for existing records
ALTER TABLE repartidor_returns
ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'confirmed';

-- Create index for performance
CREATE INDEX IF NOT EXISTS idx_repartidor_returns_status
ON repartidor_returns(status);

-- Create composite index for common queries (employee + status)
CREATE INDEX IF NOT EXISTS idx_repartidor_returns_employee_status
ON repartidor_returns(employee_id, status);

-- Update existing records to 'confirmed' (they are already processed)
UPDATE repartidor_returns
SET status = 'confirmed'
WHERE status = 'confirmed' AND created_at < NOW();

-- Add comment to column
COMMENT ON COLUMN repartidor_returns.status IS 'Estado del registro: draft (borrador editable), confirmed (confirmado en liquidación), deleted (eliminado)';

-- Log migration
DO $$
BEGIN
    RAISE NOTICE 'Migration completed: Added status column to repartidor_returns';
END $$;
