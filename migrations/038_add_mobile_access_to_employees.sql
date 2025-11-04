-- =============================================================================
-- Migration 038: Add mobile app access control to employees table
-- =============================================================================
-- This migration adds a field to control mobile app access per employee
-- Independent of role, to allow granular control:
-- - NULL / 'none' = no mobile access
-- - 'admin' = mobile access as admin (Administrador/Encargado)
-- - 'distributor' = mobile access as distributor (Repartidor)

BEGIN;

-- ═════════════════════════════════════════════════════════════════════════
-- STEP 1: Add mobile_access_type column to employees
-- ═════════════════════════════════════════════════════════════════════════

ALTER TABLE employees
ADD COLUMN IF NOT EXISTS mobile_access_type VARCHAR(50) DEFAULT NULL;

-- Add comment explaining the column
COMMENT ON COLUMN employees.mobile_access_type IS
'Mobile app access type: NULL/none = no access, admin = admin access, distributor = distributor access';

-- Add check constraint to validate values
ALTER TABLE employees
ADD CONSTRAINT check_mobile_access_type
CHECK (mobile_access_type IS NULL OR mobile_access_type IN ('none', 'admin', 'distributor'));

-- ═════════════════════════════════════════════════════════════════════════
-- STEP 2: Set default mobile_access_type based on existing role_id
-- ═════════════════════════════════════════════════════════════════════════

-- Administrador (1) and Encargado (2) get 'admin' access
UPDATE employees
SET mobile_access_type = 'admin'
WHERE mobile_access_type IS NULL AND role_id IN (1, 2);

-- Repartidor (3) gets 'distributor' access
UPDATE employees
SET mobile_access_type = 'distributor'
WHERE mobile_access_type IS NULL AND role_id = 3;

-- Ayudante (4) and Otro (99) get no access
UPDATE employees
SET mobile_access_type = 'none'
WHERE mobile_access_type IS NULL AND role_id IN (4, 99);

-- ═════════════════════════════════════════════════════════════════════════
-- STEP 3: Remove old employee_mobile_app_permissions table (no longer needed)
-- ═════════════════════════════════════════════════════════════════════════

-- Drop the table if it exists (we're consolidating to single field)
DROP TABLE IF EXISTS employee_mobile_app_permissions CASCADE;

-- ═════════════════════════════════════════════════════════════════════════
-- STEP 4: Create index for mobile access queries
-- ═════════════════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_employees_mobile_access
ON employees(mobile_access_type)
WHERE mobile_access_type IS NOT NULL;

-- ═════════════════════════════════════════════════════════════════════════
-- STEP 5: Verify migration success
-- ═════════════════════════════════════════════════════════════════════════

SELECT
    'Mobile Access Mapping Summary' as status,
    (SELECT COUNT(*) FROM employees WHERE mobile_access_type = 'admin') as admin_access,
    (SELECT COUNT(*) FROM employees WHERE mobile_access_type = 'distributor') as distributor_access,
    (SELECT COUNT(*) FROM employees WHERE mobile_access_type = 'none') as no_access,
    (SELECT COUNT(*) FROM employees WHERE mobile_access_type IS NULL) as unmapped;

COMMIT;
