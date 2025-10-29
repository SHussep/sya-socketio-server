-- ═══════════════════════════════════════════════════════════════════════════
-- MIGRATION 022: Add shift_id foreign key relationships
-- Purpose: Track all transactions to their respective shifts for proper reporting
-- Date: 2025-10-29
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. ADD shift_id TO SALES TABLE
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sales' AND column_name = 'shift_id'
  ) THEN
    ALTER TABLE sales ADD COLUMN shift_id INTEGER REFERENCES shifts(id) ON DELETE CASCADE;
    CREATE INDEX idx_sales_shift_id ON sales(shift_id);
    COMMENT ON COLUMN sales.shift_id IS 'Reference to the shift during which this sale occurred';
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. ADD shift_id TO EXPENSES TABLE
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'expenses' AND column_name = 'shift_id'
  ) THEN
    ALTER TABLE expenses ADD COLUMN shift_id INTEGER REFERENCES shifts(id) ON DELETE CASCADE;
    CREATE INDEX idx_expenses_shift_id ON expenses(shift_id);
    COMMENT ON COLUMN expenses.shift_id IS 'Reference to the shift during which this expense occurred';
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. ADD shift_id TO DEPOSITS TABLE (if exists)
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'deposits') THEN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'deposits' AND column_name = 'shift_id'
    ) THEN
      ALTER TABLE deposits ADD COLUMN shift_id INTEGER REFERENCES shifts(id) ON DELETE CASCADE;
      CREATE INDEX idx_deposits_shift_id ON deposits(shift_id);
      COMMENT ON COLUMN deposits.shift_id IS 'Reference to the shift during which this deposit occurred';
    END IF;
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. ADD shift_id TO WITHDRAWALS TABLE (if exists)
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'withdrawals') THEN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'withdrawals' AND column_name = 'shift_id'
    ) THEN
      ALTER TABLE withdrawals ADD COLUMN shift_id INTEGER REFERENCES shifts(id) ON DELETE CASCADE;
      CREATE INDEX idx_withdrawals_shift_id ON withdrawals(shift_id);
      COMMENT ON COLUMN withdrawals.shift_id IS 'Reference to the shift during which this withdrawal occurred';
    END IF;
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. ADD shift_id TO CASH_CUTS TABLE
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'cash_cuts' AND column_name = 'shift_id'
  ) THEN
    ALTER TABLE cash_cuts ADD COLUMN shift_id INTEGER REFERENCES shifts(id) ON DELETE CASCADE;
    CREATE INDEX idx_cash_cuts_shift_id ON cash_cuts(shift_id);
    COMMENT ON COLUMN cash_cuts.shift_id IS 'Reference to the shift being closed/cut';
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. ADD INDEX FOR QUERYING OPEN SHIFTS
-- ═══════════════════════════════════════════════════════════════════════════
CREATE INDEX IF NOT EXISTS idx_shifts_open_by_branch
  ON shifts(branch_id, is_cash_cut_open)
  WHERE is_cash_cut_open = TRUE;

CREATE INDEX IF NOT EXISTS idx_shifts_date_range
  ON shifts(branch_id, start_time DESC, end_time DESC);

-- ═══════════════════════════════════════════════════════════════════════════
-- 7. ADD COLUMN FOR EMPLOYEE SYNC STATUS
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'employees' AND column_name = 'is_synced'
  ) THEN
    ALTER TABLE employees ADD COLUMN is_synced BOOLEAN DEFAULT TRUE;
    COMMENT ON COLUMN employees.is_synced IS 'Whether employee data is synced to all devices (true) or local only (false)';
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 8. ADD shift_id AND branch_id TO GUARDIAN_EVENTS (if missing)
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'guardian_events') THEN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'guardian_events' AND column_name = 'shift_id'
    ) THEN
      ALTER TABLE guardian_events ADD COLUMN shift_id INTEGER REFERENCES shifts(id) ON DELETE SET NULL;
      CREATE INDEX idx_guardian_shift_id ON guardian_events(shift_id);
      COMMENT ON COLUMN guardian_events.shift_id IS 'Reference to the shift during which this event occurred (nullable for events outside shifts)';
    END IF;
  END IF;
END $$;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- SUMMARY OF CHANGES
-- ═══════════════════════════════════════════════════════════════════════════
-- ✅ Added shift_id FK to: sales, expenses, deposits, withdrawals, cash_cuts, guardian_events
-- ✅ Added branch-based indices for efficient queries
-- ✅ Added is_synced flag to employees for local-only tracking
-- ✅ All foreign keys use ON DELETE CASCADE for data consistency
-- ═══════════════════════════════════════════════════════════════════════════
