-- Migration 092: Fix expenses schema cleanup
-- 1. Add payment_type_id column (required for expenses sync)
-- 2. Remove local_shift_id (no longer needed with global_id idempotency)
-- 3. Add index for payment_type_id for query performance

-- Add payment_type_id column (references tipos_pago in Desktop local DB)
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS payment_type_id INTEGER;

-- Drop local_shift_id column (redundant with global_id for idempotency)
ALTER TABLE expenses DROP COLUMN IF EXISTS local_shift_id;

-- Create index for payment_type_id to improve query performance
CREATE INDEX IF NOT EXISTS idx_expenses_payment_type ON expenses(payment_type_id);

-- Add comment to document the change
COMMENT ON COLUMN expenses.payment_type_id IS 'References Desktop TiposPago.Id (1=Efectivo, 2=Tarjeta) - no credit for expenses';
