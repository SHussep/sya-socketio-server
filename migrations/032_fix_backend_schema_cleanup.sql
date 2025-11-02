-- =============================================================================
-- Migration 032: Fix Backend Schema - Remove Desktop-only fields from PostgreSQL
-- =============================================================================
-- CRITICAL FIX: PostgreSQL (backend) should NOT have Desktop sync metadata
-- Sync metadata belongs ONLY in Desktop SQLite for tracking local changes
--
-- PostgreSQL should be the SINGLE SOURCE OF TRUTH with clean, minimal schema
-- Desktop syncs FROM backend, not the other way around

-- Step 1: Remove sync fields from employees table (ONLY Backend PostgreSQL should have these)
ALTER TABLE employees DROP COLUMN IF EXISTS synced CASCADE;
ALTER TABLE employees DROP COLUMN IF EXISTS synced_at CASCADE;
ALTER TABLE employees DROP COLUMN IF EXISTS remote_id CASCADE;

-- Step 2: Ensure password_hash in employees is used only for authentication (not sync)
-- password_hash and password_updated_at are OK in backend for auth purposes
-- but NOT for tracking sync status (that's Desktop-only)
COMMENT ON COLUMN employees.password_hash IS 'Password hash for authentication (do NOT use for sync tracking)';

-- Step 3: Add branch_id context to roles table for proper role-branch-tenant relationship
ALTER TABLE roles ADD COLUMN IF NOT EXISTS branch_id INTEGER REFERENCES branches(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_roles_branch_id ON roles(branch_id);
COMMENT ON COLUMN roles.branch_id IS 'Branch context for this role (NULL = tenant-wide role, not NULL = branch-specific role)';

-- Step 4: Create unique constraint for roles to prevent duplicates per branch
ALTER TABLE roles DROP CONSTRAINT IF EXISTS unique_role_per_branch_tenant CASCADE;
ALTER TABLE roles ADD CONSTRAINT unique_role_per_branch_tenant UNIQUE NULLS NOT DISTINCT (tenant_id, branch_id, name);

-- Step 5: Ensure employee_branches junction table is properly structured
-- (This should have been created in earlier migration, but verify it exists)
CREATE TABLE IF NOT EXISTS employee_branches (
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

-- Step 6: Update comment to clarify backend vs. desktop
COMMENT ON TABLE employees IS 'Employee records - Source of Truth. Sync metadata tracking is in Desktop SQLite only, NOT here.';
COMMENT ON TABLE roles IS 'Roles with tenant (and optionally branch) context - Source of Truth';
COMMENT ON TABLE employee_branches IS 'Junction table linking employees to branches (many-to-many relationship)';
