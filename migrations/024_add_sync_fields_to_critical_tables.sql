-- ═══════════════════════════════════════════════════════════════════════════
-- MIGRATION 024: Add sync fields to critical tables
-- Purpose: Add RemoteId, Synced, SyncedAt to Employee, Suppliers, and
--          related tables for proper synchronization tracking
-- Date: 2025-10-29
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- ADD SYNC FIELDS TO EMPLOYEES TABLE
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE employees
ADD COLUMN IF NOT EXISTS remote_id INTEGER,
ADD COLUMN IF NOT EXISTS synced BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS synced_at TIMESTAMP WITH TIME ZONE;

-- Create indices for synced status queries
CREATE INDEX IF NOT EXISTS idx_employees_synced ON employees(synced);
CREATE INDEX IF NOT EXISTS idx_employees_remote_id ON employees(remote_id);

COMMENT ON COLUMN employees.remote_id IS 'ID del registro en el servidor remoto (Desktop SQLite)';
COMMENT ON COLUMN employees.synced IS 'Indica si este registro fue sincronizado';
COMMENT ON COLUMN employees.synced_at IS 'Timestamp de la última sincronización exitosa';

-- ═══════════════════════════════════════════════════════════════════════════
-- ADD SYNC FIELDS TO SUPPLIERS TABLE
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE suppliers
ADD COLUMN IF NOT EXISTS remote_id INTEGER,
ADD COLUMN IF NOT EXISTS synced BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS synced_at TIMESTAMP WITH TIME ZONE;

-- Create indices for synced status queries
CREATE INDEX IF NOT EXISTS idx_suppliers_synced ON suppliers(synced);
CREATE INDEX IF NOT EXISTS idx_suppliers_remote_id ON suppliers(remote_id);

COMMENT ON COLUMN suppliers.remote_id IS 'ID del registro en el servidor remoto (Desktop SQLite)';
COMMENT ON COLUMN suppliers.synced IS 'Indica si este registro fue sincronizado';
COMMENT ON COLUMN suppliers.synced_at IS 'Timestamp de la última sincronización exitosa';

-- ═══════════════════════════════════════════════════════════════════════════
-- ADD SYNC FIELDS TO PURCHASES TABLE
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE purchases
ADD COLUMN IF NOT EXISTS remote_id INTEGER,
ADD COLUMN IF NOT EXISTS synced BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS synced_at TIMESTAMP WITH TIME ZONE;

-- Create indices for synced status queries
CREATE INDEX IF NOT EXISTS idx_purchases_synced ON purchases(synced);
CREATE INDEX IF NOT EXISTS idx_purchases_remote_id ON purchases(remote_id);

COMMENT ON COLUMN purchases.remote_id IS 'ID del registro en el servidor remoto (Desktop SQLite)';
COMMENT ON COLUMN purchases.synced IS 'Indica si este registro fue sincronizado';
COMMENT ON COLUMN purchases.synced_at IS 'Timestamp de la última sincronización exitosa';

-- ═══════════════════════════════════════════════════════════════════════════
-- ADD SYNC FIELDS TO SALES TABLE (if missing)
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE sales
ADD COLUMN IF NOT EXISTS remote_id INTEGER,
ADD COLUMN IF NOT EXISTS synced BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS synced_at TIMESTAMP WITH TIME ZONE;

-- Create indices for synced status queries
CREATE INDEX IF NOT EXISTS idx_sales_synced ON sales(synced);
CREATE INDEX IF NOT EXISTS idx_sales_remote_id ON sales(remote_id);

COMMENT ON COLUMN sales.remote_id IS 'ID del registro en el servidor remoto (Desktop SQLite)';
COMMENT ON COLUMN sales.synced IS 'Indica si este registro fue sincronizado';
COMMENT ON COLUMN sales.synced_at IS 'Timestamp de la última sincronización exitosa';

-- ═══════════════════════════════════════════════════════════════════════════
-- ADD SYNC FIELDS TO EXPENSES TABLE (if missing)
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE expenses
ADD COLUMN IF NOT EXISTS remote_id INTEGER,
ADD COLUMN IF NOT EXISTS synced BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS synced_at TIMESTAMP WITH TIME ZONE;

-- Create indices for synced status queries
CREATE INDEX IF NOT EXISTS idx_expenses_synced ON expenses(synced);
CREATE INDEX IF NOT EXISTS idx_expenses_remote_id ON expenses(remote_id);

COMMENT ON COLUMN expenses.remote_id IS 'ID del registro en el servidor remoto (Desktop SQLite)';
COMMENT ON COLUMN expenses.synced IS 'Indica si este registro fue sincronizado';
COMMENT ON COLUMN expenses.synced_at IS 'Timestamp de la última sincronización exitosa';

-- ═══════════════════════════════════════════════════════════════════════════
-- ADD SYNC FIELDS TO DEPOSITS TABLE (if missing)
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE deposits
ADD COLUMN IF NOT EXISTS remote_id INTEGER,
ADD COLUMN IF NOT EXISTS synced BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS synced_at TIMESTAMP WITH TIME ZONE;

-- Create indices for synced status queries
CREATE INDEX IF NOT EXISTS idx_deposits_synced ON deposits(synced);
CREATE INDEX IF NOT EXISTS idx_deposits_remote_id ON deposits(remote_id);

COMMENT ON COLUMN deposits.remote_id IS 'ID del registro en el servidor remoto (Desktop SQLite)';
COMMENT ON COLUMN deposits.synced IS 'Indica si este registro fue sincronizado';
COMMENT ON COLUMN deposits.synced_at IS 'Timestamp de la última sincronización exitosa';

-- ═══════════════════════════════════════════════════════════════════════════
-- ADD SYNC FIELDS TO WITHDRAWALS TABLE (if missing)
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE withdrawals
ADD COLUMN IF NOT EXISTS remote_id INTEGER,
ADD COLUMN IF NOT EXISTS synced BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS synced_at TIMESTAMP WITH TIME ZONE;

-- Create indices for synced status queries
CREATE INDEX IF NOT EXISTS idx_withdrawals_synced ON withdrawals(synced);
CREATE INDEX IF NOT EXISTS idx_withdrawals_remote_id ON withdrawals(remote_id);

COMMENT ON COLUMN withdrawals.remote_id IS 'ID del registro en el servidor remoto (Desktop SQLite)';
COMMENT ON COLUMN withdrawals.synced IS 'Indica si este registro fue sincronizado';
COMMENT ON COLUMN withdrawals.synced_at IS 'Timestamp de la última sincronización exitosa';

COMMIT;
