-- =============================================================================
-- Migration 030: Ensure Roles and Permissions tables exist (idempotent)
-- This migration is safe to run multiple times
-- =============================================================================

-- Step 1: Create roles table if not exists
CREATE TABLE IF NOT EXISTS roles (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    description VARCHAR(255),
    is_system BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(tenant_id, name)
);

-- Step 2: Create permissions table if not exists (global, not tenant-specific)
CREATE TABLE IF NOT EXISTS permissions (
    id SERIAL PRIMARY KEY,
    code VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(100) NOT NULL,
    description VARCHAR(255),
    category VARCHAR(50),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Step 3: Create role_permissions junction table if not exists
CREATE TABLE IF NOT EXISTS role_permissions (
    id SERIAL PRIMARY KEY,
    role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permission_id INTEGER NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(role_id, permission_id)
);

-- Step 4: Add columns to employees if they don't exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'employees' AND column_name = 'role_id'
    ) THEN
        ALTER TABLE employees ADD COLUMN role_id INTEGER REFERENCES roles(id) ON DELETE RESTRICT;
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'employees' AND column_name = 'password_hash'
    ) THEN
        ALTER TABLE employees ADD COLUMN password_hash VARCHAR(255);
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'employees' AND column_name = 'password_updated_at'
    ) THEN
        ALTER TABLE employees ADD COLUMN password_updated_at TIMESTAMP;
    END IF;
END $$;

-- Step 5: Insert standard permissions (idempotent - uses ON CONFLICT)
INSERT INTO permissions (code, name, description, category) VALUES
    ('VIEW_ALL_SALES', 'Ver todas las ventas', 'Puede ver todas las ventas del negocio', 'sales'),
    ('VIEW_OWN_SALES', 'Ver sus propias ventas', 'Solo ve las ventas que registró', 'sales'),
    ('CREATE_SALE', 'Crear venta', 'Puede registrar nuevas ventas', 'sales'),
    ('EDIT_SALE', 'Editar venta', 'Puede modificar ventas existentes', 'sales'),
    ('VIEW_ALL_DELIVERIES', 'Ver todos los repartos', 'Puede ver todos los repartos', 'deliveries'),
    ('VIEW_OWN_DELIVERIES', 'Ver sus repartos', 'Solo ve los repartos asignados', 'deliveries'),
    ('UPDATE_DELIVERY_STATUS', 'Actualizar estado de reparto', 'Puede cambiar estado (pendiente, en ruta, entregado)', 'deliveries'),
    ('ASSIGN_DELIVERIES', 'Asignar repartos', 'Puede asignar repartos a repartidores', 'deliveries'),
    ('VIEW_ALL_EXPENSES', 'Ver todos los gastos', 'Puede ver todos los gastos', 'sales'),
    ('CREATE_EXPENSE', 'Crear gasto', 'Puede registrar nuevos gastos', 'sales'),
    ('VIEW_OWN_EXPENSES', 'Ver sus gastos', 'Solo ve sus gastos personales', 'sales'),
    ('VIEW_INVENTORY', 'Ver inventario', 'Acceso al módulo de inventario', 'inventory'),
    ('EDIT_INVENTORY', 'Editar inventario', 'Puede modificar cantidades de inventario', 'inventory'),
    ('MANAGE_EMPLOYEES', 'Gestionar empleados', 'Crear, editar, eliminar empleados', 'admin'),
    ('VIEW_REPORTS', 'Ver reportes', 'Acceso a reportes y analytics', 'admin'),
    ('MANAGE_ROLES', 'Gestionar roles', 'Crear y modificar roles y permisos', 'admin')
ON CONFLICT (code) DO NOTHING;

-- Step 6: Create indices for better query performance
CREATE INDEX IF NOT EXISTS idx_roles_tenant_id ON roles(tenant_id);
CREATE INDEX IF NOT EXISTS idx_employees_role_id ON employees(role_id);
CREATE INDEX IF NOT EXISTS idx_role_permissions_role_id ON role_permissions(role_id);
CREATE INDEX IF NOT EXISTS idx_role_permissions_permission_id ON role_permissions(permission_id);
CREATE INDEX IF NOT EXISTS idx_permissions_code ON permissions(code);

-- Step 7: Insert system roles for all existing tenants (idempotent)
INSERT INTO roles (tenant_id, name, description, is_system)
SELECT DISTINCT tenants.id, 'Owner', 'Propietario con acceso total al sistema', true
FROM tenants
WHERE NOT EXISTS (
    SELECT 1 FROM roles r
    WHERE r.tenant_id = tenants.id AND r.name = 'Owner' AND r.is_system = true
)
ON CONFLICT DO NOTHING;

INSERT INTO roles (tenant_id, name, description, is_system)
SELECT DISTINCT tenants.id, 'Repartidor', 'Repartidor con acceso limitado a funciones específicas', true
FROM tenants
WHERE NOT EXISTS (
    SELECT 1 FROM roles r
    WHERE r.tenant_id = tenants.id AND r.name = 'Repartidor' AND r.is_system = true
)
ON CONFLICT DO NOTHING;

-- Step 8: Assign all permissions to Owner role (idempotent)
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.is_system = true
    AND r.name = 'Owner'
    AND NOT EXISTS (
        SELECT 1 FROM role_permissions rp
        WHERE rp.role_id = r.id AND rp.permission_id = p.id
    )
ON CONFLICT DO NOTHING;

-- Step 9: Assign limited permissions to Repartidor role (idempotent)
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.is_system = true
    AND r.name = 'Repartidor'
    AND p.code IN (
        'VIEW_OWN_SALES',
        'VIEW_OWN_DELIVERIES',
        'UPDATE_DELIVERY_STATUS',
        'CREATE_EXPENSE',
        'VIEW_OWN_EXPENSES'
    )
    AND NOT EXISTS (
        SELECT 1 FROM role_permissions rp
        WHERE rp.role_id = r.id AND rp.permission_id = p.id
    )
ON CONFLICT DO NOTHING;
