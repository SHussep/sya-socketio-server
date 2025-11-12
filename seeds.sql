-- =====================================================
-- PostgreSQL Database Seeds - Initial Data
-- SYA Tortillerías System
-- =====================================================
-- This file contains the essential seed data that must
-- exist in the database for the system to work.
-- =====================================================

-- ========== SUBSCRIPTIONS ==========
-- Plans available for tenants
INSERT INTO subscriptions (name, max_branches, max_devices, max_devices_per_branch, max_employees, is_active)
VALUES
    ('Basic', 1, 2, 2, 10, true),
    ('Pro', 5, 10, 5, 50, true),
    ('Enterprise', 999, 999, 999, 999, true)
ON CONFLICT (name) DO NOTHING;

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

-- Log completion
DO $$
BEGIN
    RAISE NOTICE '✅ Seeds aplicados: % subscriptions, % roles',
        (SELECT COUNT(*) FROM subscriptions),
        (SELECT COUNT(*) FROM roles);
END $$;
