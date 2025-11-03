-- =============================================================================
-- Migration 037: Create Global Roles and Permissions System
-- =============================================================================
-- This migration establishes a role-based access control system:
-- 1. Create GLOBAL roles table (NO tenant_id, NO branch_id, fixed IDs)
-- 2. Create permissions table with all system permissions
-- 3. Create role_permissions junction table
-- 4. Seed fixed global roles (1-4 standard, 99 for custom)
-- 5. Create employee_mobile_app_permissions for mobile access control

BEGIN;

-- ═════════════════════════════════════════════════════════════════════════
-- STEP 1: Create GLOBAL Roles Table (NOT tenant-scoped)
-- ═════════════════════════════════════════════════════════════════════════

-- Drop old tenant-scoped table if exists
DROP TABLE IF EXISTS roles CASCADE;

-- Create new global roles table with FIXED IDs (not SERIAL)
CREATE TABLE IF NOT EXISTS roles (
    id INTEGER PRIMARY KEY,
    name VARCHAR(255) NOT NULL UNIQUE,
    description TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Insert all 5 global roles with FIXED IDs
INSERT INTO roles (id, name, description, created_at, updated_at)
VALUES
    (1, 'Administrador', 'Acceso total al sistema', NOW(), NOW()),
    (2, 'Encargado', 'Gerente de turno - permisos extensos', NOW(), NOW()),
    (3, 'Repartidor', 'Acceso limitado como repartidor', NOW(), NOW()),
    (4, 'Ayudante', 'Soporte - acceso limitado', NOW(), NOW()),
    (99, 'Otro', 'Rol genérico para roles personalizados desde Desktop', NOW(), NOW())
ON CONFLICT (id) DO UPDATE SET updated_at = NOW();

-- ═════════════════════════════════════════════════════════════════════════
-- STEP 2: Create Permissions Table
-- ═════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS permissions (
    id SERIAL PRIMARY KEY,
    code VARCHAR(255) NOT NULL UNIQUE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    category VARCHAR(100),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Insert mobile app permission codes
INSERT INTO permissions (code, name, description, category)
VALUES
    ('AccessMobileAppAsAdmin', 'Acceso a App Móvil como Admin', 'Permite acceso a la app móvil con permisos de administrador', 'mobile'),
    ('AccessMobileAppAsDistributor', 'Acceso a App Móvil como Repartidor', 'Permite acceso a la app móvil como repartidor', 'mobile')
ON CONFLICT (code) DO NOTHING;

-- ═════════════════════════════════════════════════════════════════════════
-- STEP 3: Create Role-Permissions Junction Table
-- ═════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS role_permissions (
    id SERIAL PRIMARY KEY,
    role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permission_id INTEGER,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(role_id, permission_id)
);

-- ═════════════════════════════════════════════════════════════════════════
-- STEP 4: Create Mobile App Permissions Table
-- ═════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS employee_mobile_app_permissions (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL,
    employee_id INTEGER NOT NULL,
    permission_key VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(tenant_id, employee_id, permission_key)
);

CREATE INDEX IF NOT EXISTS idx_employee_mobile_permissions_tenant ON employee_mobile_app_permissions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_employee_mobile_permissions_employee ON employee_mobile_app_permissions(employee_id);
CREATE INDEX IF NOT EXISTS idx_employee_mobile_permissions_key ON employee_mobile_app_permissions(permission_key);

-- ═════════════════════════════════════════════════════════════════════════
-- STEP 5: Ensure employees.role_id points to global roles
-- ═════════════════════════════════════════════════════════════════════════

-- Add role_id column if not exists
ALTER TABLE employees ADD COLUMN IF NOT EXISTS role_id INTEGER;

-- Update role_id to reference global roles (map old tenant-scoped IDs if needed)
-- For now, set all NULL role_ids to 1 (Administrador)
UPDATE employees
SET role_id = 1
WHERE role_id IS NULL;

-- Add/update FK constraint to point to global roles table
ALTER TABLE employees DROP CONSTRAINT IF EXISTS fk_employees_role_id;
ALTER TABLE employees ADD CONSTRAINT fk_employees_role_id
    FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE RESTRICT;

-- ═════════════════════════════════════════════════════════════════════════
-- STEP 6: Commit All Changes
-- ═════════════════════════════════════════════════════════════════════════

COMMIT;

-- Summary
SELECT
    'Sistema de Roles Global Creado' as mensaje,
    (SELECT COUNT(*) FROM roles) as total_global_roles,
    (SELECT COUNT(*) FROM permissions) as total_permissions,
    (SELECT COUNT(*) FROM employee_mobile_app_permissions) as mobile_app_assignments;
