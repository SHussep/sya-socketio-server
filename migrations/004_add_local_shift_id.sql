-- Migration: Add local_shift_id for offline-first support
-- Purpose: Track local shift IDs to enable proper sync when offline
-- Date: 2025-10-28

-- 1. Add local_shift_id to shifts table
ALTER TABLE shifts ADD COLUMN local_shift_id INT UNIQUE;
COMMENT ON COLUMN shifts.local_shift_id IS 'Local shift ID from Desktop app - used for offline sync reconciliation';

-- 2. Add local_shift_id to sales table
ALTER TABLE sales ADD COLUMN local_shift_id INT;
COMMENT ON COLUMN sales.local_shift_id IS 'Local sale ID from Desktop app - tracks which local shift this sale belongs to';

-- 3. Add local_shift_id to expenses table
ALTER TABLE expenses ADD COLUMN local_shift_id INT;
COMMENT ON COLUMN expenses.local_shift_id IS 'Local expense ID from Desktop app - tracks which local shift this expense belongs to';

-- 4. Add local_shift_id to deposits table (if exists)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'deposits') THEN
    ALTER TABLE deposits ADD COLUMN local_shift_id INT;
    COMMENT ON COLUMN deposits.local_shift_id IS 'Local deposit ID from Desktop app - tracks which local shift this deposit belongs to';
  END IF;
END $$;

-- 5. Add local_shift_id to withdrawals table (if exists)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'withdrawals') THEN
    ALTER TABLE withdrawals ADD COLUMN local_shift_id INT;
    COMMENT ON COLUMN withdrawals.local_shift_id IS 'Local withdrawal ID from Desktop app - tracks which local shift this withdrawal belongs to';
  END IF;
END $$;

-- 6. Create indexes for faster lookups
CREATE INDEX idx_shifts_local_shift_id ON shifts(local_shift_id);
CREATE INDEX idx_shifts_employee_open ON shifts(employee_id) WHERE end_time IS NULL;
CREATE INDEX idx_sales_local_shift_id ON sales(local_shift_id);
CREATE INDEX idx_expenses_local_shift_id ON expenses(local_shift_id);

-- 7. Log migration
INSERT INTO migration_log (migration_name, executed_at, status)
VALUES ('004_add_local_shift_id', NOW(), 'success')
ON CONFLICT DO NOTHING;
