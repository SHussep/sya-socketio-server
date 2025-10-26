-- ═══════════════════════════════════════════════════════════════
-- MIGRATION 016: Fix sales and expenses timestamps to TIMESTAMP WITH TIME ZONE (UTC)
-- ═══════════════════════════════════════════════════════════════

-- 1. SALES - Convert sale_date to TIMESTAMP WITH TIME ZONE in UTC
-- This fixes the timezone issue where sales were saved with server timezone (+1100)
-- instead of UTC (+0000)
ALTER TABLE sales
  ALTER COLUMN sale_date TYPE TIMESTAMP WITH TIME ZONE
    USING sale_date AT TIME ZONE 'UTC';

-- 2. EXPENSES - Convert expense_date to TIMESTAMP WITH TIME ZONE in UTC
ALTER TABLE expenses
  ALTER COLUMN expense_date TYPE TIMESTAMP WITH TIME ZONE
    USING expense_date AT TIME ZONE 'UTC';

-- 3. PURCHASES - Also convert purchase_date for consistency
ALTER TABLE purchases
  ALTER COLUMN purchase_date TYPE TIMESTAMP WITH TIME ZONE
    USING purchase_date AT TIME ZONE 'UTC';

-- 4. CASH_DRAWER_SESSIONS - Convert all session timestamps
ALTER TABLE cash_drawer_sessions
  ALTER COLUMN start_time TYPE TIMESTAMP WITH TIME ZONE USING start_time AT TIME ZONE 'UTC',
  ALTER COLUMN close_time TYPE TIMESTAMP WITH TIME ZONE USING close_time AT TIME ZONE 'UTC',
  ALTER COLUMN opened_at TYPE TIMESTAMP WITH TIME ZONE USING opened_at AT TIME ZONE 'UTC',
  ALTER COLUMN closed_at TYPE TIMESTAMP WITH TIME ZONE USING closed_at AT TIME ZONE 'UTC';

-- 5. CASH_TRANSACTIONS - Convert transaction timestamps
ALTER TABLE cash_transactions
  ALTER COLUMN transaction_timestamp TYPE TIMESTAMP WITH TIME ZONE USING transaction_timestamp AT TIME ZONE 'UTC',
  ALTER COLUMN voided_at TYPE TIMESTAMP WITH TIME ZONE USING voided_at AT TIME ZONE 'UTC';

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
