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

TRUNCATE TABLE ventas_detalle RESTART IDENTITY CASCADE;
TRUNCATE TABLE ventas RESTART IDENTITY CASCADE;
TRUNCATE TABLE credit_payments RESTART IDENTITY CASCADE;
TRUNCATE TABLE repartidor_returns RESTART IDENTITY CASCADE;
TRUNCATE TABLE repartidor_assignments RESTART IDENTITY CASCADE;
TRUNCATE TABLE expenses RESTART IDENTITY CASCADE;
TRUNCATE TABLE cash_cuts RESTART IDENTITY CASCADE;
TRUNCATE TABLE shifts RESTART IDENTITY CASCADE;

-- ═══════════════════════════════════════════════════════════════════════════
-- PASO 2: Eliminar relaciones de empleados
-- ═══════════════════════════════════════════════════════════════════════════

TRUNCATE TABLE employee_branches RESTART IDENTITY CASCADE;
TRUNCATE TABLE devices RESTART IDENTITY CASCADE;

-- ═══════════════════════════════════════════════════════════════════════════
-- PASO 3: Eliminar empleados, clientes, productos
-- ═══════════════════════════════════════════════════════════════════════════

TRUNCATE TABLE employees RESTART IDENTITY CASCADE;
TRUNCATE TABLE customers RESTART IDENTITY CASCADE;
TRUNCATE TABLE products RESTART IDENTITY CASCADE;

-- ═══════════════════════════════════════════════════════════════════════════
-- PASO 4: Eliminar sucursales
-- ═══════════════════════════════════════════════════════════════════════════

TRUNCATE TABLE branches RESTART IDENTITY CASCADE;

-- ═══════════════════════════════════════════════════════════════════════════
-- PASO 5: Eliminar tenants (negocios)
-- ═══════════════════════════════════════════════════════════════════════════

TRUNCATE TABLE tenants RESTART IDENTITY CASCADE;

-- ═══════════════════════════════════════════════════════════════════════════
-- NOTA: subscriptions y roles NO se eliminan (son seeds)
-- ═══════════════════════════════════════════════════════════════════════════

-- Habilitar nuevamente los triggers
SET CONSTRAINTS ALL IMMEDIATE;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- RESUMEN
-- ═══════════════════════════════════════════════════════════════════════════

SELECT
    'Limpieza completada. Tablas vaciadas:' as mensaje,
    (SELECT COUNT(*) FROM tenants) as tenants,
    (SELECT COUNT(*) FROM branches) as branches,
    (SELECT COUNT(*) FROM employees) as employees,
    (SELECT COUNT(*) FROM devices) as devices,
    (SELECT COUNT(*) FROM ventas) as ventas,
    (SELECT COUNT(*) FROM customers) as customers;

SELECT
    'Tablas maestras preservadas:' as mensaje,
    (SELECT COUNT(*) FROM subscriptions) as subscriptions,
    (SELECT COUNT(*) FROM roles) as roles;
