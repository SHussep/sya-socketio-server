-- =============================================================================
-- Migration 033: Fix Employees and Employee-Branches Schema
-- =============================================================================
-- CRITICAL FIX: Align schema with actual code expectations
--
-- Issues:
-- 1. employees table has 'role' (string) but code expects 'role_id' (foreign key)
-- 2. employee_branches has permission fields but should be simple many-to-many
-- 3. employees table missing tenant_id, password_hash, password_updated_at, etc.

-- Step 1: Backup existing employee_branches data if needed
-- (We'll drop and recreate since it has the wrong structure)

-- Step 2: Add missing columns to employees table
-- These columns should exist but might be missing
ALTER TABLE employees ADD COLUMN IF NOT EXISTS password_hash VARCHAR;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS password_updated_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS is_owner BOOLEAN DEFAULT false;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS google_user_identifier VARCHAR;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;

-- Step 3: Create role_id column and copy data from role column
-- First check if role_id already exists
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'employees' AND column_name = 'role_id'
    ) THEN
        -- Add role_id column temporarily nullable
        ALTER TABLE employees ADD COLUMN role_id INTEGER;

        -- For existing employees, map their string role to a role_id
        -- This is a temporary migration - in production you'd map properly
        UPDATE employees e
        SET role_id = CASE
            WHEN e.role = 'owner' THEN 1
            WHEN e.role = 'encargado' THEN 2
            WHEN e.role = 'repartidor' THEN 3
            WHEN e.role = 'ayudante' THEN 4
            ELSE 2 -- Default to encargado
        END
        WHERE role_id IS NULL;

        -- Make role_id NOT NULL after populating
        ALTER TABLE employees ALTER COLUMN role_id SET NOT NULL;

        -- Add foreign key constraint
        ALTER TABLE employees ADD CONSTRAINT fk_employees_role_id
            FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE RESTRICT;
    END IF;
END $$;

-- Step 4: Drop the old 'role' column since we now use role_id
ALTER TABLE employees DROP COLUMN IF EXISTS role CASCADE;

-- Step 5: Recreate employee_branches table with correct structure
-- First, drop the old table
DROP TABLE IF EXISTS employee_branches CASCADE;

-- Create new employee_branches with correct structure
CREATE TABLE employee_branches (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    is_active BOOLEAN DEFAULT true,
    assigned_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(tenant_id, employee_id, branch_id)
);

-- Create indices for employee_branches
CREATE INDEX IF NOT EXISTS idx_employee_branches_tenant_id ON employee_branches(tenant_id);
CREATE INDEX IF NOT EXISTS idx_employee_branches_employee_id ON employee_branches(employee_id);
CREATE INDEX IF NOT EXISTS idx_employee_branches_branch_id ON employee_branches(branch_id);
CREATE INDEX IF NOT EXISTS idx_employee_branches_is_active ON employee_branches(is_active);

-- Step 6: Recreate employee-branch relationships for existing employees
-- Link each employee to their main_branch if it exists
INSERT INTO employee_branches (tenant_id, employee_id, branch_id, is_active)
SELECT DISTINCT e.tenant_id, e.id, e.main_branch_id, true
FROM employees e
WHERE e.main_branch_id IS NOT NULL
ON CONFLICT (tenant_id, employee_id, branch_id) DO NOTHING;

-- Step 7: Update employees table constraints and indices
ALTER TABLE employees ADD CONSTRAINT fk_employees_main_branch_id
    FOREIGN KEY (main_branch_id) REFERENCES branches(id) ON DELETE SET NULL;

-- Ensure proper indices exist
CREATE INDEX IF NOT EXISTS idx_employees_tenant_id ON employees(tenant_id);
CREATE INDEX IF NOT EXISTS idx_employees_role_id ON employees(role_id);
CREATE INDEX IF NOT EXISTS idx_employees_email ON employees(LOWER(email));
CREATE INDEX IF NOT EXISTS idx_employees_username ON employees(LOWER(username));
CREATE INDEX IF NOT EXISTS idx_employees_is_active ON employees(is_active);

-- Step 8: Add comments for clarity
COMMENT ON TABLE employees IS 'Employee records - does NOT contain Desktop sync metadata (synced, synced_at, remote_id)';
COMMENT ON TABLE employee_branches IS 'Junction table linking employees to branches (many-to-many relationship) - managed by Desktop sync';
COMMENT ON COLUMN employees.role_id IS 'Foreign key to roles table for employee permissions';
COMMENT ON COLUMN employees.password_hash IS 'BCrypt hashed password - set by sync from Desktop';
COMMENT ON COLUMN employee_branches.tenant_id IS 'Tenant context - ensures employee-branch is scoped to tenant';
