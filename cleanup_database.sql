-- ═══════════════════════════════════════════════════════════════
-- SCRIPT DE LIMPIEZA - PostgreSQL Database
-- ═══════════════════════════════════════════════════════════════
-- ADVERTENCIA: Este script eliminará TODOS los datos de tenants,
-- branches y registros relacionados. Usar solo en desarrollo.
-- ═══════════════════════════════════════════════════════════════

BEGIN;

-- Eliminar en orden correcto para respetar foreign keys
-- De tablas hijo (dependientes) a tablas padre (independientes)
-- Usar IF EXISTS para no fallar en tablas que no existan

-- 1. Backups metadata
DO $$ BEGIN
    IF EXISTS (SELECT FROM pg_tables WHERE tablename = 'backup_metadata') THEN
        TRUNCATE TABLE backup_metadata RESTART IDENTITY CASCADE;
    END IF;
END $$;

-- 2. Tablas operacionales (pueden no existir todas)
DO $$ BEGIN
    IF EXISTS (SELECT FROM pg_tables WHERE tablename = 'shifts') THEN
        TRUNCATE TABLE shifts RESTART IDENTITY CASCADE;
    END IF;
    IF EXISTS (SELECT FROM pg_tables WHERE tablename = 'sales') THEN
        TRUNCATE TABLE sales RESTART IDENTITY CASCADE;
    END IF;
    IF EXISTS (SELECT FROM pg_tables WHERE tablename = 'expenses') THEN
        TRUNCATE TABLE expenses RESTART IDENTITY CASCADE;
    END IF;
    IF EXISTS (SELECT FROM pg_tables WHERE tablename = 'purchases') THEN
        TRUNCATE TABLE purchases RESTART IDENTITY CASCADE;
    END IF;
    IF EXISTS (SELECT FROM pg_tables WHERE tablename = 'inventory_adjustments') THEN
        TRUNCATE TABLE inventory_adjustments RESTART IDENTITY CASCADE;
    END IF;
    IF EXISTS (SELECT FROM pg_tables WHERE tablename = 'price_updates') THEN
        TRUNCATE TABLE price_updates RESTART IDENTITY CASCADE;
    END IF;
    IF EXISTS (SELECT FROM pg_tables WHERE tablename = 'employee_branches') THEN
        TRUNCATE TABLE employee_branches RESTART IDENTITY CASCADE;
    END IF;
END $$;

-- 3. Productos
DO $$ BEGIN
    IF EXISTS (SELECT FROM pg_tables WHERE tablename = 'products') THEN
        TRUNCATE TABLE products RESTART IDENTITY CASCADE;
    END IF;
END $$;

-- 4. Empleados
TRUNCATE TABLE employees RESTART IDENTITY CASCADE;

-- 5. Branches
TRUNCATE TABLE branches RESTART IDENTITY CASCADE;

-- 6. Tenants
TRUNCATE TABLE tenants RESTART IDENTITY CASCADE;

-- Las secuencias ya se reiniciaron con RESTART IDENTITY CASCADE
-- Subscriptions se mantienen (son datos maestros)

COMMIT;

-- Verificar que quedó limpio
SELECT 'Tenants restantes:' as tabla, COUNT(*) as total FROM tenants
UNION ALL
SELECT 'Branches restantes:', COUNT(*) FROM branches
UNION ALL
SELECT 'Employees restantes:', COUNT(*) FROM employees
UNION ALL
SELECT 'Backups restantes:', COUNT(*) FROM backup_metadata;
