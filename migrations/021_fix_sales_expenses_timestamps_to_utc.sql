-- ═══════════════════════════════════════════════════════════════
-- MIGRATION 016: Fix sales and expenses timestamps to TIMESTAMP WITH TIME ZONE (UTC)
-- ═══════════════════════════════════════════════════════════════

-- 1. SALES - Convert sale_date to TIMESTAMP WITH TIME ZONE in UTC
-- This fixes the timezone issue where sales were saved with server timezone (+1100)
-- instead of UTC (+0000)
-- Note: Using CREATE/DROP approach because views depend on this column
DO $$
BEGIN
  -- Check if sale_date is already TIMESTAMP WITH TIME ZONE
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sales' AND column_name = 'sale_date'
    AND data_type = 'timestamp without time zone'
  ) THEN
    -- Create temporary column with correct type
    ALTER TABLE sales ADD COLUMN sale_date_tmp TIMESTAMP WITH TIME ZONE;
    -- Copy data with timezone conversion
    UPDATE sales SET sale_date_tmp = sale_date AT TIME ZONE 'UTC';
    -- Drop old column
    ALTER TABLE sales DROP COLUMN sale_date;
    -- Rename temporary column
    ALTER TABLE sales RENAME COLUMN sale_date_tmp TO sale_date;
  END IF;
END $$;

-- 2. EXPENSES - Convert expense_date to TIMESTAMP WITH TIME ZONE in UTC
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'expenses' AND column_name = 'expense_date' AND data_type = 'timestamp without time zone') THEN
    ALTER TABLE expenses ADD COLUMN expense_date_tmp TIMESTAMP WITH TIME ZONE;
    UPDATE expenses SET expense_date_tmp = expense_date AT TIME ZONE 'UTC';
    ALTER TABLE expenses DROP COLUMN expense_date;
    ALTER TABLE expenses RENAME COLUMN expense_date_tmp TO expense_date;
  END IF;
END $$;

-- 3. PURCHASES - Also convert purchase_date for consistency
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'purchases' AND column_name = 'purchase_date' AND data_type = 'timestamp without time zone') THEN
    ALTER TABLE purchases ADD COLUMN purchase_date_tmp TIMESTAMP WITH TIME ZONE;
    UPDATE purchases SET purchase_date_tmp = purchase_date AT TIME ZONE 'UTC';
    ALTER TABLE purchases DROP COLUMN purchase_date;
    ALTER TABLE purchases RENAME COLUMN purchase_date_tmp TO purchase_date;
  END IF;
END $$;

-- 4. CASH_DRAWER_SESSIONS - Convert all session timestamps
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cash_drawer_sessions' AND column_name = 'start_time' AND data_type = 'timestamp without time zone') THEN
    ALTER TABLE cash_drawer_sessions ADD COLUMN start_time_tmp TIMESTAMP WITH TIME ZONE;
    UPDATE cash_drawer_sessions SET start_time_tmp = start_time AT TIME ZONE 'UTC';
    ALTER TABLE cash_drawer_sessions DROP COLUMN start_time;
    ALTER TABLE cash_drawer_sessions RENAME COLUMN start_time_tmp TO start_time;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cash_drawer_sessions' AND column_name = 'close_time' AND data_type = 'timestamp without time zone') THEN
    ALTER TABLE cash_drawer_sessions ADD COLUMN close_time_tmp TIMESTAMP WITH TIME ZONE;
    UPDATE cash_drawer_sessions SET close_time_tmp = close_time AT TIME ZONE 'UTC';
    ALTER TABLE cash_drawer_sessions DROP COLUMN close_time;
    ALTER TABLE cash_drawer_sessions RENAME COLUMN close_time_tmp TO close_time;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cash_drawer_sessions' AND column_name = 'opened_at' AND data_type = 'timestamp without time zone') THEN
    ALTER TABLE cash_drawer_sessions ADD COLUMN opened_at_tmp TIMESTAMP WITH TIME ZONE;
    UPDATE cash_drawer_sessions SET opened_at_tmp = opened_at AT TIME ZONE 'UTC';
    ALTER TABLE cash_drawer_sessions DROP COLUMN opened_at;
    ALTER TABLE cash_drawer_sessions RENAME COLUMN opened_at_tmp TO opened_at;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cash_drawer_sessions' AND column_name = 'closed_at' AND data_type = 'timestamp without time zone') THEN
    ALTER TABLE cash_drawer_sessions ADD COLUMN closed_at_tmp TIMESTAMP WITH TIME ZONE;
    UPDATE cash_drawer_sessions SET closed_at_tmp = closed_at AT TIME ZONE 'UTC';
    ALTER TABLE cash_drawer_sessions DROP COLUMN closed_at;
    ALTER TABLE cash_drawer_sessions RENAME COLUMN closed_at_tmp TO closed_at;
  END IF;
END $$;

-- 5. CASH_TRANSACTIONS - Convert transaction timestamps
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cash_transactions' AND column_name = 'transaction_timestamp' AND data_type = 'timestamp without time zone') THEN
    ALTER TABLE cash_transactions ADD COLUMN transaction_timestamp_tmp TIMESTAMP WITH TIME ZONE;
    UPDATE cash_transactions SET transaction_timestamp_tmp = transaction_timestamp AT TIME ZONE 'UTC';
    ALTER TABLE cash_transactions DROP COLUMN transaction_timestamp;
    ALTER TABLE cash_transactions RENAME COLUMN transaction_timestamp_tmp TO transaction_timestamp;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cash_transactions' AND column_name = 'voided_at' AND data_type = 'timestamp without time zone') THEN
    ALTER TABLE cash_transactions ADD COLUMN voided_at_tmp TIMESTAMP WITH TIME ZONE;
    UPDATE cash_transactions SET voided_at_tmp = voided_at AT TIME ZONE 'UTC';
    ALTER TABLE cash_transactions DROP COLUMN voided_at;
    ALTER TABLE cash_transactions RENAME COLUMN voided_at_tmp TO voided_at;
  END IF;
END $$;

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_sales_sale_date ON sales(sale_date DESC);
CREATE INDEX IF NOT EXISTS idx_expenses_expense_date ON expenses(expense_date DESC);
CREATE INDEX IF NOT EXISTS idx_purchases_purchase_date ON purchases(purchase_date DESC);

-- Log migration completion
DO $$
BEGIN
  RAISE NOTICE 'Migration 016: Sales and expenses timestamps converted to TIMESTAMP WITH TIME ZONE (UTC)';
  RAISE NOTICE '  - sales.sale_date';
  RAISE NOTICE '  - expenses.expense_date';
  RAISE NOTICE '  - purchases.purchase_date';
  RAISE NOTICE '  - cash_drawer_sessions timestamps';
  RAISE NOTICE '  - cash_transactions timestamps';
  RAISE NOTICE 'All transaction timestamps are now stored in UTC with timezone awareness.';
END $$;
