-- =============================================================================
-- Migration 035: Fix employees password column
-- =============================================================================
-- The original schema has 'password' (NOT NULL) but we use 'password_hash'
-- Need to make password nullable since we use password_hash for actual storage

-- Step 1: Make password column nullable (it was previously NOT NULL with no default)
ALTER TABLE employees ALTER COLUMN password DROP NOT NULL;

-- Step 2: Add comment explaining the change
COMMENT ON COLUMN employees.password IS 'DEPRECATED - Use password_hash instead. Kept for backward compatibility.';
