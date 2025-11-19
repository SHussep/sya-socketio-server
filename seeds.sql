-- =====================================================
-- PostgreSQL Database Seeds - Initial Data
-- SYA Tortillerías System
-- =====================================================
-- This file contains the essential seed data that must
-- exist in the database for the system to work.
-- =====================================================

-- ========== SUBSCRIPTIONS ==========
-- Plans available for tenants
INSERT INTO subscriptions (id, name, max_branches, max_devices, max_devices_per_branch, max_employees, is_active)
VALUES
    (1, 'Trial', 1, 1, 1, 5, true),           -- Plan de prueba gratuito (30 días)
    (2, 'Basic', 1, 2, 2, 10, true),          -- Plan básico
    (3, 'Pro', 5, 10, 5, 50, true),           -- Plan profesional
    (4, 'Enterprise', 999, 999, 999, 999, true) -- Plan empresarial ilimitado
ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    max_branches = EXCLUDED.max_branches,
    max_devices = EXCLUDED.max_devices,
    max_devices_per_branch = EXCLUDED.max_devices_per_branch,
    max_employees = EXCLUDED.max_employees,
    is_active = EXCLUDED.is_active;

-- ========== ROLES ==========
-- GLOBAL roles with FIXED IDs (NOT tenant-scoped)
-- These IDs must NEVER change as they are referenced throughout the system
INSERT INTO roles (id, name, description, created_at)
VALUES
    (1, 'Administrador', 'Acceso total al sistema', NOW()),
    (2, 'Encargado', 'Gerente de turno - permisos extensos', NOW()),
    (3, 'Repartidor', 'Acceso limitado como repartidor', NOW()),
    (4, 'Ayudante', 'Soporte - acceso limitado', NOW()),
    (99, 'Otro', 'Rol genérico para roles personalizados desde Desktop', NOW())
ON CONFLICT (id) DO UPDATE SET updated_at = NOW();

-- ========== TENANTS DE PRUEBA ==========
-- Tenants de ejemplo para testing del sistema de licencias
-- IMPORTANTE: Estos datos son SOLO para desarrollo/testing

INSERT INTO tenants (id, tenant_code, business_name, email, phone_number, subscription_id, subscription_status, trial_ends_at, is_active)
VALUES
    -- TENANT 1: Trial activo (30 días restantes)
    (1, 'TENANT001', 'Tortillería Los Pinos', 'lospinos@test.com', '555-0001', 1, 'trial', NOW() + INTERVAL '30 days', true),

    -- TENANT 2: Trial por vencer (5 días restantes) - Para probar alertas
    (2, 'TENANT002', 'Tortillería La Esperanza', 'esperanza@test.com', '555-0002', 1, 'trial', NOW() + INTERVAL '5 days', true),

    -- TENANT 3: Trial EXPIRADO - Para probar bloqueo
    (3, 'TENANT003', 'Tortillería El Sol', 'elsol@test.com', '555-0003', 1, 'expired', NOW() - INTERVAL '5 days', true),

    -- TENANT 4: Subscripción Basic ACTIVA (1 año)
    (4, 'TENANT004', 'Tortillería Premium', 'premium@test.com', '555-0004', 2, 'active', NOW() + INTERVAL '1 year', true),

    -- TENANT 5: Trial que vence HOY - Para probar edge case
    (5, 'TENANT005', 'Tortillería Último Día', 'ultimodia@test.com', '555-0005', 1, 'trial', NOW() + INTERVAL '1 hour', true)
ON CONFLICT (id) DO UPDATE SET
    tenant_code = EXCLUDED.tenant_code,
    business_name = EXCLUDED.business_name,
    email = EXCLUDED.email,
    phone_number = EXCLUDED.phone_number,
    subscription_id = EXCLUDED.subscription_id,
    subscription_status = EXCLUDED.subscription_status,
    trial_ends_at = EXCLUDED.trial_ends_at,
    is_active = EXCLUDED.is_active,
    updated_at = NOW();

-- ========== BRANCHES DE PRUEBA ==========
-- Crear una sucursal para cada tenant de prueba

INSERT INTO branches (id, tenant_id, branch_code, name, address, phone, timezone, is_active)
VALUES
    (1, 1, 'BR001', 'Sucursal Principal - Los Pinos', 'Av. Principal #123', '555-0001', 'America/Mexico_City', true),
    (2, 2, 'BR001', 'Sucursal Principal - La Esperanza', 'Calle 5 de Mayo #456', '555-0002', 'America/Mexico_City', true),
    (3, 3, 'BR001', 'Sucursal Principal - El Sol', 'Boulevard Reforma #789', '555-0003', 'America/Mexico_City', true),
    (4, 4, 'BR001', 'Sucursal Principal - Premium', 'Centro Comercial #101', '555-0004', 'America/Mexico_City', true),
    (5, 5, 'BR001', 'Sucursal Principal - Último Día', 'Plaza Central #202', '555-0005', 'America/Mexico_City', true)
ON CONFLICT (tenant_id, branch_code) DO UPDATE SET
    name = EXCLUDED.name,
    address = EXCLUDED.address,
    phone = EXCLUDED.phone,
    updated_at = NOW();

-- ========== EMPLEADOS DE PRUEBA ==========
-- Crear un administrador para cada tenant (password: "admin123")
-- Hash bcrypt para "admin123": $2a$10$rKZHvIy2K4vX8hW.UqZqLOxH7eQXzJ0QZLGKJxKxLGKJxKxLGKJxK

INSERT INTO employees (id, tenant_id, username, first_name, last_name, email, password_hash, role_id, is_active, is_owner, main_branch_id, global_id)
VALUES
    -- Tenant 1: Los Pinos (Trial activo 30 días)
    (1, 1, 'admin', 'Juan', 'Pérez', 'admin@lospinos.com', '$2a$10$CwTycUXWue0Thq9StjUM0uJ8VKwvzKJQP8KxkXQJxkXQJxkXQJxkO', 1, true, true, 1, 'EMP-1-' || gen_random_uuid()),

    -- Tenant 2: La Esperanza (Trial 5 días)
    (2, 2, 'admin', 'María', 'González', 'admin@esperanza.com', '$2a$10$CwTycUXWue0Thq9StjUM0uJ8VKwvzKJQP8KxkXQJxkXQJxkXQJxkO', 1, true, true, 2, 'EMP-2-' || gen_random_uuid()),

    -- Tenant 3: El Sol (EXPIRADO)
    (3, 3, 'admin', 'Carlos', 'Ramírez', 'admin@elsol.com', '$2a$10$CwTycUXWue0Thq9StjUM0uJ8VKwvzKJQP8KxkXQJxkXQJxkXQJxkO', 1, true, true, 3, 'EMP-3-' || gen_random_uuid()),

    -- Tenant 4: Premium (Subscripción activa)
    (4, 4, 'admin', 'Ana', 'Martínez', 'admin@premium.com', '$2a$10$CwTycUXWue0Thq9StjUM0uJ8VKwvzKJQP8KxkXQJxkXQJxkXQJxkO', 1, true, true, 4, 'EMP-4-' || gen_random_uuid()),

    -- Tenant 5: Último Día (Expira hoy)
    (5, 5, 'admin', 'Luis', 'Sánchez', 'admin@ultimodia.com', '$2a$10$CwTycUXWue0Thq9StjUM0uJ8VKwvzKJQP8KxkXQJxkXQJxkXQJxkO', 1, true, true, 5, 'EMP-5-' || gen_random_uuid())
ON CONFLICT (global_id) DO UPDATE SET
    username = EXCLUDED.username,
    first_name = EXCLUDED.first_name,
    last_name = EXCLUDED.last_name,
    email = EXCLUDED.email,
    updated_at = NOW();

-- Asignar empleados a sus sucursales
INSERT INTO employee_branches (tenant_id, employee_id, branch_id, can_login, can_sell, can_manage_inventory, can_close_shift)
VALUES
    (1, 1, 1, true, true, true, true),
    (2, 2, 2, true, true, true, true),
    (3, 3, 3, true, true, true, true),
    (4, 4, 4, true, true, true, true),
    (5, 5, 5, true, true, true, true)
ON CONFLICT (tenant_id, employee_id, branch_id) DO NOTHING;

-- Log completion
DO $$
BEGIN
    RAISE NOTICE '✅ Seeds aplicados:';
    RAISE NOTICE '  - % subscriptions', (SELECT COUNT(*) FROM subscriptions);
    RAISE NOTICE '  - % roles', (SELECT COUNT(*) FROM roles);
    RAISE NOTICE '  - % tenants de prueba', (SELECT COUNT(*) FROM tenants);
    RAISE NOTICE '  - % branches', (SELECT COUNT(*) FROM branches);
    RAISE NOTICE '  - % employees', (SELECT COUNT(*) FROM employees);
    RAISE NOTICE '';
    RAISE NOTICE '📊 ESTADO DE LICENCIAS:';
    RAISE NOTICE '  - Tenant 1 (Los Pinos): Trial activo 30 días ✅';
    RAISE NOTICE '  - Tenant 2 (Esperanza): Trial 5 días ⚠️';
    RAISE NOTICE '  - Tenant 3 (El Sol): EXPIRADO ❌';
    RAISE NOTICE '  - Tenant 4 (Premium): Basic activa 1 año ✅';
    RAISE NOTICE '  - Tenant 5 (Último Día): Expira HOY ⚠️';
    RAISE NOTICE '';
    RAISE NOTICE '🔑 CREDENCIALES DE PRUEBA:';
    RAISE NOTICE '  - Usuario: admin';
    RAISE NOTICE '  - Password: admin123';
END $$;
