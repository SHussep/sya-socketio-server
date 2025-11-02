-- =============================================================================
-- Migration 029: Seed system roles (Owner and Repartidor) for all tenants
-- =============================================================================
-- This migration creates the two system roles for each tenant and assigns
-- the appropriate permissions to each role

-- Step 1: Insert system roles for all existing tenants
INSERT INTO roles (tenant_id, name, description, is_system)
SELECT t.id, 'Owner', 'Propietario con acceso total al sistema', true
FROM tenants t
WHERE NOT EXISTS (
    SELECT 1 FROM roles r
    WHERE r.tenant_id = t.id AND r.name = 'Owner' AND r.is_system = true
)
ON CONFLICT DO NOTHING;

INSERT INTO roles (tenant_id, name, description, is_system)
SELECT t.id, 'Repartidor', 'Repartidor con acceso limitado a funciones específicas', true
FROM tenants t
WHERE NOT EXISTS (
    SELECT 1 FROM roles r
    WHERE r.tenant_id = t.id AND r.name = 'Repartidor' AND r.is_system = true
)
ON CONFLICT DO NOTHING;

-- Step 2: Assign all permissions to Owner role
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

-- Step 3: Assign limited permissions to Repartidor role
-- Repartidor can: view own sales, view own deliveries, update delivery status,
-- create/view own expenses
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
