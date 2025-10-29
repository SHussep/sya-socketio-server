-- ═══════════════════════════════════════════════════════════════════════════
-- MIGRATION 026: Remove unnecessary sync fields from PostgreSQL tables
-- Purpose: Remove remote_id, synced, synced_at fields that are not relevant
--          in PostgreSQL. These fields only make sense in SQLite local database.
--          PostgreSQL IS the source of truth, so sync tracking is unnecessary.
-- Date: 2025-10-29
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- DROP UNNECESSARY INDICES FIRST
-- ═══════════════════════════════════════════════════════════════════════════

DROP INDEX IF EXISTS idx_employees_synced;
DROP INDEX IF EXISTS idx_employees_remote_id;
DROP INDEX IF EXISTS idx_suppliers_synced;
DROP INDEX IF EXISTS idx_suppliers_remote_id;
DROP INDEX IF EXISTS idx_purchases_synced;
DROP INDEX IF EXISTS idx_purchases_remote_id;
DROP INDEX IF EXISTS idx_sales_synced;
DROP INDEX IF EXISTS idx_sales_remote_id;
DROP INDEX IF EXISTS idx_expenses_synced;
DROP INDEX IF EXISTS idx_expenses_remote_id;
DROP INDEX IF EXISTS idx_deposits_synced;
DROP INDEX IF EXISTS idx_deposits_remote_id;
DROP INDEX IF EXISTS idx_withdrawals_synced;
DROP INDEX IF EXISTS idx_withdrawals_remote_id;
DROP INDEX IF EXISTS idx_branches_synced;
DROP INDEX IF EXISTS idx_branches_remote_id;
DROP INDEX IF EXISTS idx_branches_tenant_synced;
DROP INDEX IF EXISTS idx_tenants_synced;
DROP INDEX IF EXISTS idx_tenants_remote_id;

-- ═══════════════════════════════════════════════════════════════════════════
-- DROP UNNECESSARY COLUMNS
-- ═══════════════════════════════════════════════════════════════════════════

-- Remove from employees table
ALTER TABLE employees
DROP COLUMN IF EXISTS remote_id,
DROP COLUMN IF EXISTS synced,
DROP COLUMN IF EXISTS synced_at;

-- Remove from suppliers table
ALTER TABLE suppliers
DROP COLUMN IF EXISTS remote_id,
DROP COLUMN IF EXISTS synced,
DROP COLUMN IF EXISTS synced_at;

-- Remove from purchases table
ALTER TABLE purchases
DROP COLUMN IF EXISTS remote_id,
DROP COLUMN IF EXISTS synced,
DROP COLUMN IF EXISTS synced_at;

-- Remove from sales table
ALTER TABLE sales
DROP COLUMN IF EXISTS remote_id,
DROP COLUMN IF EXISTS synced,
DROP COLUMN IF EXISTS synced_at;

-- Remove from expenses table
ALTER TABLE expenses
DROP COLUMN IF EXISTS remote_id,
DROP COLUMN IF EXISTS synced,
DROP COLUMN IF EXISTS synced_at;

-- Remove from deposits table
ALTER TABLE deposits
DROP COLUMN IF EXISTS remote_id,
DROP COLUMN IF EXISTS synced,
DROP COLUMN IF EXISTS synced_at;

-- Remove from withdrawals table
ALTER TABLE withdrawals
DROP COLUMN IF EXISTS remote_id,
DROP COLUMN IF EXISTS synced,
DROP COLUMN IF EXISTS synced_at;

-- Remove from branches table
ALTER TABLE branches
DROP COLUMN IF EXISTS remote_id,
DROP COLUMN IF EXISTS synced,
DROP COLUMN IF EXISTS synced_at;

-- Remove from tenants table
ALTER TABLE tenants
DROP COLUMN IF EXISTS remote_id,
DROP COLUMN IF EXISTS synced,
DROP COLUMN IF EXISTS synced_at;

COMMIT;
