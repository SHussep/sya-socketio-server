-- =============================================================================
-- Migration 037: Create Comprehensive Roles and Permissions System
-- =============================================================================
-- This migration establishes a complete role-based access control (RBAC) system:
-- 1. Create roles table (only 2 system roles: Administrador, Repartidor)
-- 2. Create permissions table with all system permissions
-- 3. Create role_permissions junction table
-- 4. Seed default roles and permissions
-- 5. Ensure proper multi-tenant isolation

BEGIN;

-- ═════════════════════════════════════════════════════════════════════════
-- STEP 1: Create Roles Table (System Roles Only)
-- ═════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS roles (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    is_system BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,

    -- Ensure unique role names per tenant
    UNIQUE(tenant_id, name)
);

CREATE INDEX IF NOT EXISTS idx_roles_tenant_id ON roles(tenant_id);
CREATE INDEX IF NOT EXISTS idx_roles_is_system ON roles(is_system);

-- ═════════════════════════════════════════════════════════════════════════
-- STEP 2: Create Permissions Table (All System Permissions)
-- ═════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS permissions (
    id SERIAL PRIMARY KEY,
    code VARCHAR(255) NOT NULL UNIQUE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    category VARCHAR(100),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Insert all system permissions (one-time only)
INSERT INTO permissions (code, name, description, category)
VALUES
    -- Core Access
    ('mobile_app_access', 'Acceso a App Móvil', 'Permite acceso completo a la app móvil y todos los datos en PostgreSQL', 'access'),
    ('desktop_app_access', 'Acceso a App Desktop', 'Permite usar la aplicación Desktop', 'access'),

    -- Sales Operations
    ('create_sale', 'Crear Ventas', 'Registrar nuevas ventas', 'sales'),
    ('view_sales', 'Ver Ventas', 'Ver historial de ventas', 'sales'),
    ('edit_sale', 'Editar Ventas', 'Modificar ventas existentes', 'sales'),
    ('void_sale', 'Anular Ventas', 'Anular transacciones de venta', 'sales'),

    -- Inventory Management
    ('view_inventory', 'Ver Inventario', 'Ver stocks y productos', 'inventory'),
    ('manage_inventory', 'Gestionar Inventario', 'Actualizar stocks y crear productos', 'inventory'),

    -- Cash Management
    ('view_cash_drawer', 'Ver Caja', 'Ver estado de caja', 'cash'),
    ('manage_cash_drawer', 'Gestionar Caja', 'Abrir/cerrar caja y registrar transacciones', 'cash'),
    ('close_shift', 'Cerrar Turno', 'Cerrar turno y arqueos', 'cash'),

    -- Employee Management
    ('view_employees', 'Ver Empleados', 'Ver listado de empleados', 'employees'),
    ('manage_employees', 'Gestionar Empleados', 'Crear, editar, eliminar empleados', 'employees'),
    ('manage_roles', 'Gestionar Roles', 'Asignar roles y permisos a empleados', 'employees'),

    -- Reports
    ('view_reports', 'Ver Reportes', 'Acceder a reportes y análisis', 'reports'),
    ('export_data', 'Exportar Datos', 'Exportar datos en múltiples formatos', 'reports'),

    -- System Administration
    ('manage_branches', 'Gestionar Sucursales', 'Crear y editar sucursales', 'admin'),
    ('manage_settings', 'Gestionar Configuración', 'Cambiar configuración del sistema', 'admin'),
    ('view_audit_log', 'Ver Log de Auditoría', 'Ver historial de cambios', 'admin')
ON CONFLICT (code) DO NOTHING;

-- ═════════════════════════════════════════════════════════════════════════
-- STEP 3: Create Role-Permissions Junction Table
-- ═════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS role_permissions (
    id SERIAL PRIMARY KEY,
    role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permission_id INTEGER NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,

    -- Prevent duplicate role-permission assignments
    UNIQUE(role_id, permission_id)
);

CREATE INDEX IF NOT EXISTS idx_role_permissions_role_id ON role_permissions(role_id);
CREATE INDEX IF NOT EXISTS idx_role_permissions_permission_id ON role_permissions(permission_id);

-- ═════════════════════════════════════════════════════════════════════════
-- STEP 4: Create System Roles and Assign Permissions
-- ═════════════════════════════════════════════════════════════════════════

-- For each tenant that doesn't have system roles, create them
DO $$
DECLARE
    tenant_record RECORD;
    admin_role_id INTEGER;
    repartidor_role_id INTEGER;
BEGIN
    -- Iterate through all tenants
    FOR tenant_record IN SELECT id FROM tenants LOOP

        -- Check if Administrador role already exists for this tenant
        IF NOT EXISTS (
            SELECT 1 FROM roles
            WHERE tenant_id = tenant_record.id AND name = 'Administrador'
        ) THEN
            -- Create Administrador role with full permissions
            INSERT INTO roles (tenant_id, name, description, is_system)
            VALUES (
                tenant_record.id,
                'Administrador',
                'Acceso completo al sistema y todos los datos',
                true
            )
            RETURNING id INTO admin_role_id;

            -- Assign ALL permissions to Administrador
            INSERT INTO role_permissions (role_id, permission_id)
            SELECT admin_role_id, id FROM permissions
            ON CONFLICT (role_id, permission_id) DO NOTHING;
        END IF;

        -- Check if Repartidor role already exists for this tenant
        IF NOT EXISTS (
            SELECT 1 FROM roles
            WHERE tenant_id = tenant_record.id AND name = 'Repartidor'
        ) THEN
            -- Create Repartidor role with limited permissions
            INSERT INTO roles (tenant_id, name, description, is_system)
            VALUES (
                tenant_record.id,
                'Repartidor',
                'Acceso limitado para reparto y ventas',
                true
            )
            RETURNING id INTO repartidor_role_id;

            -- Assign limited permissions to Repartidor
            INSERT INTO role_permissions (role_id, permission_id)
            SELECT repartidor_role_id, p.id FROM permissions p
            WHERE p.code IN (
                'mobile_app_access',
                'create_sale',
                'view_sales',
                'view_inventory',
                'view_cash_drawer',
                'close_shift'
            )
            ON CONFLICT (role_id, permission_id) DO NOTHING;
        END IF;

    END LOOP;
END $$;

-- ═════════════════════════════════════════════════════════════════════════
-- STEP 5: Delete any non-system roles from previous migration attempts
-- ═════════════════════════════════════════════════════════════════════════

DELETE FROM role_permissions
WHERE role_id IN (
    SELECT id FROM roles
    WHERE is_system = false OR name NOT IN ('Administrador', 'Repartidor')
);

DELETE FROM roles
WHERE is_system = false OR name NOT IN ('Administrador', 'Repartidor');

-- ═════════════════════════════════════════════════════════════════════════
-- STEP 6: Update Employees Table to Reference Role System
-- ═════════════════════════════════════════════════════════════════════════

-- Ensure role_id column exists
ALTER TABLE employees ADD COLUMN IF NOT EXISTS role_id INTEGER;

-- For any employees without a role_id, assign Administrador (id=1 by default per tenant)
-- This is a safe default - should be manually adjusted
UPDATE employees e
SET role_id = COALESCE(
    (SELECT id FROM roles WHERE tenant_id = e.tenant_id AND name = 'Administrador' LIMIT 1),
    (SELECT id FROM roles WHERE is_system = true AND name = 'Administrador' ORDER BY id LIMIT 1)
)
WHERE e.role_id IS NULL;

-- Add NOT NULL constraint if it doesn't exist
ALTER TABLE employees ALTER COLUMN role_id SET NOT NULL;

-- Add FK constraint if it doesn't exist
ALTER TABLE employees DROP CONSTRAINT IF EXISTS fk_employees_role_id CASCADE;
ALTER TABLE employees ADD CONSTRAINT fk_employees_role_id
    FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE RESTRICT;

-- ═════════════════════════════════════════════════════════════════════════
-- STEP 7: Update Employee-Branches Table
-- ═════════════════════════════════════════════════════════════════════════

-- Add removed_at column for soft deletes (if not already added by migration 036)
ALTER TABLE employee_branches ADD COLUMN IF NOT EXISTS removed_at TIMESTAMP WITH TIME ZONE;

-- Create index for quick lookups of active relationships
CREATE INDEX IF NOT EXISTS idx_employee_branches_removed_at ON employee_branches(removed_at);
CREATE INDEX IF NOT EXISTS idx_employee_branches_active ON employee_branches(removed_at) WHERE removed_at IS NULL;

-- ═════════════════════════════════════════════════════════════════════════
-- STEP 8: Create View for Easy Permission Checks
-- ═════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW employee_permissions_view AS
SELECT
    e.id as employee_id,
    e.tenant_id,
    e.email,
    e.full_name,
    r.id as role_id,
    r.name as role_name,
    p.code as permission_code,
    p.name as permission_name,
    p.category as permission_category
FROM employees e
JOIN roles r ON e.role_id = r.id
JOIN role_permissions rp ON r.id = rp.role_id
JOIN permissions p ON rp.permission_id = p.id
WHERE e.is_active = true;

-- ═════════════════════════════════════════════════════════════════════════
-- STEP 9: Log Summary
-- ═════════════════════════════════════════════════════════════════════════

COMMIT;

-- Return summary
SELECT
    'Sistema de Roles y Permisos Creado' as mensaje,
    (SELECT COUNT(*) FROM roles WHERE is_system = true) as system_roles,
    (SELECT COUNT(*) FROM permissions) as total_permissions,
    (SELECT COUNT(*) FROM role_permissions) as role_permission_mappings;
