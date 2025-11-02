-- =============================================================================
-- Migration 028: Add Roles, Permissions, and RolePermissions tables
-- =============================================================================
-- This migration creates the RBAC (Role-Based Access Control) system
-- with two system roles: Owner (full access) and Repartidor (limited access)

-- Step 1: Create roles table
CREATE TABLE IF NOT EXISTS roles (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    description VARCHAR(255),
    is_system BOOLEAN DEFAULT false,  -- true para Owner/Repartidor (built-in roles)
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(tenant_id, name)
);

-- Step 2: Create permissions table (global, not tenant-specific)
CREATE TABLE IF NOT EXISTS permissions (
    id SERIAL PRIMARY KEY,
    code VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(100) NOT NULL,
    description VARCHAR(255),
    category VARCHAR(50),  -- 'sales', 'deliveries', 'inventory', 'admin'
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Step 3: Create role_permissions junction table
CREATE TABLE IF NOT EXISTS role_permissions (
    id SERIAL PRIMARY KEY,
    role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permission_id INTEGER NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(role_id, permission_id)
);

-- Step 4: Update employees table with role_id and password fields if they don't exist
ALTER TABLE employees ADD COLUMN IF NOT EXISTS role_id INTEGER REFERENCES roles(id) ON DELETE RESTRICT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS password_updated_at TIMESTAMP;

-- Step 5: Insert standard permissions (if not already present)
INSERT INTO permissions (code, name, description, category) VALUES
    -- Sales permissions
    ('VIEW_ALL_SALES', 'Ver todas las ventas', 'Puede ver todas las ventas del negocio', 'sales'),
    ('VIEW_OWN_SALES', 'Ver sus propias ventas', 'Solo ve las ventas que registró', 'sales'),
    ('CREATE_SALE', 'Crear venta', 'Puede registrar nuevas ventas', 'sales'),
    ('EDIT_SALE', 'Editar venta', 'Puede modificar ventas existentes', 'sales'),

    -- Delivery permissions
    ('VIEW_ALL_DELIVERIES', 'Ver todos los repartos', 'Puede ver todos los repartos', 'deliveries'),
    ('VIEW_OWN_DELIVERIES', 'Ver sus repartos', 'Solo ve los repartos asignados', 'deliveries'),
    ('UPDATE_DELIVERY_STATUS', 'Actualizar estado de reparto', 'Puede cambiar estado (pendiente, en ruta, entregado)', 'deliveries'),
    ('ASSIGN_DELIVERIES', 'Asignar repartos', 'Puede asignar repartos a repartidores', 'deliveries'),

    -- Expense permissions
    ('VIEW_ALL_EXPENSES', 'Ver todos los gastos', 'Puede ver todos los gastos', 'sales'),
    ('CREATE_EXPENSE', 'Crear gasto', 'Puede registrar nuevos gastos', 'sales'),
    ('VIEW_OWN_EXPENSES', 'Ver sus gastos', 'Solo ve sus gastos personales', 'sales'),

    -- Inventory permissions
    ('VIEW_INVENTORY', 'Ver inventario', 'Acceso al módulo de inventario', 'inventory'),
    ('EDIT_INVENTORY', 'Editar inventario', 'Puede modificar cantidades de inventario', 'inventory'),

    -- Admin permissions
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
