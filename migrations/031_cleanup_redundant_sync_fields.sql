-- =============================================================================
-- Migration 031: Remove redundant sync fields from Backend (PostgreSQL)
-- =============================================================================
-- Removes 'synced' and 'remote_id' fields from tables that don't need them
-- These fields only make sense in SQLite (Desktop/Mobile local databases)
-- In PostgreSQL (the central server), everything is already "synced by definition"

-- Drop synced and remote_id from sales table
ALTER TABLE sales DROP COLUMN IF EXISTS synced CASCADE;
ALTER TABLE sales DROP COLUMN IF EXISTS remote_id CASCADE;

-- Drop potentially confusing assignment-related columns from sales
-- (these should only exist in Desktop SQLite)
ALTER TABLE sales DROP COLUMN IF EXISTS monto_asignado CASCADE;
ALTER TABLE sales DROP COLUMN IF EXISTS monto_devuelto CASCADE;
ALTER TABLE sales DROP COLUMN IF EXISTS monto_vendido CASCADE;
ALTER TABLE sales DROP COLUMN IF EXISTS fecha_devolucion CASCADE;

-- Drop synced from expenses if it exists
ALTER TABLE expenses DROP COLUMN IF EXISTS synced CASCADE;
ALTER TABLE expenses DROP COLUMN IF EXISTS remote_id CASCADE;

-- Drop repartidor_assignments from Backend if it exists
-- (This table only belongs in Desktop SQLite, not in PostgreSQL)
DROP TABLE IF EXISTS repartidor_assignments CASCADE;

-- Add useful metadata columns to sales if they don't exist
ALTER TABLE sales ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS synced_from_desktop_at TIMESTAMP;

-- Ensure sales table has proper constraints
-- Remove any stale indexes
DROP INDEX IF EXISTS idx_sales_synced CASCADE;
DROP INDEX IF EXISTS idx_sales_remote_id CASCADE;

-- Create fresh indexes for common queries
CREATE INDEX IF NOT EXISTS idx_sales_tenant_id ON sales(tenant_id);
CREATE INDEX IF NOT EXISTS idx_sales_employee_id ON sales(employee_id);
CREATE INDEX IF NOT EXISTS idx_sales_sale_date ON sales(sale_date DESC);
