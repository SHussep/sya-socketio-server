-- =============================================================================
-- Migration 040: Remove deprecated password column from employees table
-- =============================================================================
-- The employees table had BOTH 'password' and 'password_hash' for legacy reasons
-- Migration 035 marked 'password' as DEPRECATED
-- We now remove it completely to simplify the schema
--
-- Security: ONLY password_hash should be stored (bcrypt hash, NEVER plain text)
-- Flow: Desktop sends password (bcrypt hash) → Backend saves as password_hash

BEGIN;

-- ═════════════════════════════════════════════════════════════════════════
-- STEP 1: Drop the deprecated password column
-- ═════════════════════════════════════════════════════════════════════════

ALTER TABLE employees
DROP COLUMN IF EXISTS password;

-- ═════════════════════════════════════════════════════════════════════════
-- STEP 2: Add comment clarifying the password flow
-- ═════════════════════════════════════════════════════════════════════════

COMMENT ON COLUMN employees.password_hash IS
'Bcrypt-hashed password. Received from Desktop (which does the hashing).
Format: $2b$12$... (bcrypt hash)
NEVER store plain text passwords.';

-- ═════════════════════════════════════════════════════════════════════════
-- STEP 3: Verify structure
-- ═════════════════════════════════════════════════════════════════════════

SELECT 'Password field cleanup complete' as status,
       (SELECT COUNT(*) FROM employees WHERE password_hash IS NULL) as employees_without_password,
       (SELECT COUNT(*) FROM employees) as total_employees;

COMMIT;
