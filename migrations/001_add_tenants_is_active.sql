-- Migration: Add is_active column to tenants table
-- Date: 2025-11-16
-- Description: Fix error "column t.is_active does not exist" in auth.js

-- Add is_active column to tenants if it doesn't exist
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;

-- Update existing tenants to be active by default
UPDATE tenants SET is_active = true WHERE is_active IS NULL;

-- Add index for better query performance
CREATE INDEX IF NOT EXISTS idx_tenants_is_active ON tenants(is_active);

-- Log migration
SELECT 'Migration 001_add_tenants_is_active.sql completed successfully' AS status;
