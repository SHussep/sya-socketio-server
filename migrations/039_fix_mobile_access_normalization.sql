-- =============================================================================
-- Migration 039: Fix mobile app access - Replace varchar with boolean
-- =============================================================================
-- Corrects the design to be properly normalized:
-- - Remove redundant mobile_access_type VARCHAR column
-- - Add simple can_use_mobile_app BOOLEAN column
-- - Access TYPE is derived from role_id + can_use_mobile_app:
--   * role 1,2 (Admin/Encargado) + can_use_mobile_app=true → 'admin'
--   * role 3 (Repartidor) + can_use_mobile_app=true → 'distributor'
--   * role 4 (Ayudante) → always false (cannot use mobile)
--   * role 99 (Otro) + can_use_mobile_app=true → 'none' (undefined)

BEGIN;

-- ═════════════════════════════════════════════════════════════════════════
-- STEP 1: Drop the redundant mobile_access_type column
-- ═════════════════════════════════════════════════════════════════════════

ALTER TABLE employees
DROP COLUMN IF EXISTS mobile_access_type;

-- ═════════════════════════════════════════════════════════════════════════
-- STEP 2: Add simple boolean column
-- ═════════════════════════════════════════════════════════════════════════

ALTER TABLE employees
ADD COLUMN IF NOT EXISTS can_use_mobile_app BOOLEAN DEFAULT false;

-- ═════════════════════════════════════════════════════════════════════════
-- STEP 3: Set can_use_mobile_app based on role_id
-- ═════════════════════════════════════════════════════════════════════════

-- Roles that should have mobile access by default:
-- 1 = Administrador (always true)
-- 2 = Encargado (always true)
-- 3 = Repartidor (always true)
-- 4 = Ayudante (always false - cannot use mobile)
-- 99 = Otro (false by default - undefined access)

UPDATE employees
SET can_use_mobile_app = CASE
    WHEN role_id IN (1, 2, 3) THEN true   -- Admin, Encargado, Repartidor
    ELSE false                             -- Ayudante, Otro, or any other
END
WHERE can_use_mobile_app = false;  -- Only update defaults

-- ═════════════════════════════════════════════════════════════════════════
-- STEP 4: Create index for mobile access queries
-- ═════════════════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_employees_can_use_mobile_app
ON employees(can_use_mobile_app)
WHERE can_use_mobile_app = true;

-- ═════════════════════════════════════════════════════════════════════════
-- STEP 5: Verification
-- ═════════════════════════════════════════════════════════════════════════

SELECT
    'Mobile Access Configuration' as status,
    (SELECT COUNT(*) FROM employees WHERE can_use_mobile_app = true) as with_mobile_access,
    (SELECT COUNT(*) FROM employees WHERE can_use_mobile_app = false) as without_mobile_access,
    (SELECT COUNT(*) FROM employees) as total_employees;

COMMIT;
