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

-- ========== GLOBAL EXPENSE CATEGORIES ==========
-- Categorías de gastos GLOBALES con IDs canónicos (1-14 secuenciales)
-- IMPORTANTE: Estos IDs deben coincidir con Desktop y Mobile
INSERT INTO global_expense_categories (id, name, description, is_measurable, unit_abbreviation, sort_order)
VALUES
    (1, 'Maíz / Maseca / Harina', 'Materias primas', TRUE, 'kg', 1),
    (2, 'Gas LP', 'Gas para producción', TRUE, 'L', 2),
    (3, 'Combustible Vehículos', 'Gasolina/Diésel para reparto', TRUE, 'L', 3),
    (4, 'Consumibles (Papel, Bolsas)', 'Materiales empaque', FALSE, NULL, 4),
    (5, 'Refacciones Moto', 'Refacciones moto', FALSE, NULL, 5),
    (6, 'Refacciones Auto', 'Refacciones auto', FALSE, NULL, 6),
    (7, 'Mantenimiento Maquinaria', 'Mantenimiento equipo', FALSE, NULL, 7),
    (8, 'Sueldos y Salarios', 'Nómina', FALSE, NULL, 8),
    (9, 'Impuestos (ISR, IVA)', 'Obligaciones fiscales', FALSE, NULL, 9),
    (10, 'Servicios (Luz, Agua, Teléfono)', 'Servicios públicos', FALSE, NULL, 10),
    (11, 'Limpieza', 'Materiales limpieza', FALSE, NULL, 11),
    (12, 'Otros Gastos', 'No clasificados', FALSE, NULL, 12),
    (13, 'Comida', 'Viáticos y alimentación', FALSE, NULL, 13),
    (14, 'Otros', 'Otros gastos', FALSE, NULL, 14)
ON CONFLICT (id) DO NOTHING;

-- Log completion
DO $$
BEGIN
    RAISE NOTICE '✅ Seeds aplicados:';
    RAISE NOTICE '  - % subscriptions', (SELECT COUNT(*) FROM subscriptions);
    RAISE NOTICE '  - % roles', (SELECT COUNT(*) FROM roles);
    RAISE NOTICE '  - % global_expense_categories', (SELECT COUNT(*) FROM global_expense_categories);
    RAISE NOTICE '';
    RAISE NOTICE '💡 NOTA: No se crearon tenants de prueba';
    RAISE NOTICE '   Los tenants se crean desde la app móvil al registrarse';
    RAISE NOTICE '   El desktop se vincula mediante "Join Branch" o "Restore Account"';
END $$;
