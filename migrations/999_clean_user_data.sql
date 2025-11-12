-- ═══════════════════════════════════════════════════════════════════════════
-- Script de Limpieza: Eliminar datos de usuarios pero preservar tablas master
-- ═══════════════════════════════════════════════════════════════════════════
-- Fecha: 2025-11-12
-- Descripción: Clean all user data on every deploy when CLEAN_DATABASE_ON_START=true
--              Preserves seeds (subscriptions, roles)
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- Deshabilitar temporalmente los triggers de foreign keys
SET CONSTRAINTS ALL DEFERRED;

-- ═══════════════════════════════════════════════════════════════════════════
-- PASO 1: Eliminar datos transaccionales (children first)
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
BEGIN
    -- Truncate only tables that exist
    IF EXISTS (SELECT FROM pg_tables WHERE tablename = 'ventas_detalle') THEN
        TRUNCATE TABLE ventas_detalle RESTART IDENTITY CASCADE;
    END IF;

    IF EXISTS (SELECT FROM pg_tables WHERE tablename = 'ventas') THEN
        TRUNCATE TABLE ventas RESTART IDENTITY CASCADE;
    END IF;

    IF EXISTS (SELECT FROM pg_tables WHERE tablename = 'credit_payments') THEN
        TRUNCATE TABLE credit_payments RESTART IDENTITY CASCADE;
    END IF;

    IF EXISTS (SELECT FROM pg_tables WHERE tablename = 'repartidor_returns') THEN
        TRUNCATE TABLE repartidor_returns RESTART IDENTITY CASCADE;
    END IF;

    IF EXISTS (SELECT FROM pg_tables WHERE tablename = 'repartidor_assignments') THEN
        TRUNCATE TABLE repartidor_assignments RESTART IDENTITY CASCADE;
    END IF;

    IF EXISTS (SELECT FROM pg_tables WHERE tablename = 'expenses') THEN
        TRUNCATE TABLE expenses RESTART IDENTITY CASCADE;
    END IF;

    IF EXISTS (SELECT FROM pg_tables WHERE tablename = 'cash_cuts') THEN
        TRUNCATE TABLE cash_cuts RESTART IDENTITY CASCADE;
    END IF;

    IF EXISTS (SELECT FROM pg_tables WHERE tablename = 'shifts') THEN
        TRUNCATE TABLE shifts RESTART IDENTITY CASCADE;
    END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- PASO 2: Eliminar relaciones de empleados
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_tables WHERE tablename = 'employee_branches') THEN
        TRUNCATE TABLE employee_branches RESTART IDENTITY CASCADE;
    END IF;

    IF EXISTS (SELECT FROM pg_tables WHERE tablename = 'devices') THEN
        TRUNCATE TABLE devices RESTART IDENTITY CASCADE;
    END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- PASO 3: Eliminar empleados, clientes, productos
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_tables WHERE tablename = 'employees') THEN
        TRUNCATE TABLE employees RESTART IDENTITY CASCADE;
    END IF;

    IF EXISTS (SELECT FROM pg_tables WHERE tablename = 'customers') THEN
        TRUNCATE TABLE customers RESTART IDENTITY CASCADE;
    END IF;

    IF EXISTS (SELECT FROM pg_tables WHERE tablename = 'products') THEN
        TRUNCATE TABLE products RESTART IDENTITY CASCADE;
    END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- PASO 4: Eliminar sucursales
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_tables WHERE tablename = 'branches') THEN
        TRUNCATE TABLE branches RESTART IDENTITY CASCADE;
    END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- PASO 5: Eliminar tenants (negocios)
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_tables WHERE tablename = 'tenants') THEN
        TRUNCATE TABLE tenants RESTART IDENTITY CASCADE;
    END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- NOTA: subscriptions y roles NO se eliminan (son seeds)
-- ═══════════════════════════════════════════════════════════════════════════

-- Habilitar nuevamente los triggers
SET CONSTRAINTS ALL IMMEDIATE;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- RESUMEN
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
    tenant_count INT := 0;
    branch_count INT := 0;
    employee_count INT := 0;
    device_count INT := 0;
    venta_count INT := 0;
    customer_count INT := 0;
    subscription_count INT := 0;
    role_count INT := 0;
BEGIN
    -- Count only if tables exist
    IF EXISTS (SELECT FROM pg_tables WHERE tablename = 'tenants') THEN
        SELECT COUNT(*) INTO tenant_count FROM tenants;
    END IF;

    IF EXISTS (SELECT FROM pg_tables WHERE tablename = 'branches') THEN
        SELECT COUNT(*) INTO branch_count FROM branches;
    END IF;

    IF EXISTS (SELECT FROM pg_tables WHERE tablename = 'employees') THEN
        SELECT COUNT(*) INTO employee_count FROM employees;
    END IF;

    IF EXISTS (SELECT FROM pg_tables WHERE tablename = 'devices') THEN
        SELECT COUNT(*) INTO device_count FROM devices;
    END IF;

    IF EXISTS (SELECT FROM pg_tables WHERE tablename = 'ventas') THEN
        SELECT COUNT(*) INTO venta_count FROM ventas;
    END IF;

    IF EXISTS (SELECT FROM pg_tables WHERE tablename = 'customers') THEN
        SELECT COUNT(*) INTO customer_count FROM customers;
    END IF;

    IF EXISTS (SELECT FROM pg_tables WHERE tablename = 'subscriptions') THEN
        SELECT COUNT(*) INTO subscription_count FROM subscriptions;
    END IF;

    IF EXISTS (SELECT FROM pg_tables WHERE tablename = 'roles') THEN
        SELECT COUNT(*) INTO role_count FROM roles;
    END IF;

    RAISE NOTICE 'Limpieza completada - Tenants: %, Branches: %, Employees: %, Devices: %, Ventas: %, Customers: %',
        tenant_count, branch_count, employee_count, device_count, venta_count, customer_count;
    RAISE NOTICE 'Seeds preservados - Subscriptions: %, Roles: %', subscription_count, role_count;
END $$;
