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

-- Log completion
DO $$
BEGIN
    RAISE NOTICE '✅ Seeds aplicados:';
    RAISE NOTICE '  - % subscriptions', (SELECT COUNT(*) FROM subscriptions);
    RAISE NOTICE '  - % roles', (SELECT COUNT(*) FROM roles);
    RAISE NOTICE '';
    RAISE NOTICE '💡 NOTA: No se crearon tenants de prueba';
    RAISE NOTICE '   Los tenants se crean desde la app móvil al registrarse';
    RAISE NOTICE '   El desktop se vincula mediante "Join Branch" o "Restore Account"';
END $$;
