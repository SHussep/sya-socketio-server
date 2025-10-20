-- ═══════════════════════════════════════════════════════════════════════════
-- Script de Limpieza: Eliminar datos de usuarios pero preservar tablas master
-- ═══════════════════════════════════════════════════════════════════════════
-- Fecha: 2025-10-19
-- Descripción: Elimina todos los datos de usuarios y transacciones,
--              pero PRESERVA las tablas maestras como subscriptions.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- Deshabilitar temporalmente los triggers de foreign keys
SET CONSTRAINTS ALL DEFERRED;

-- ═══════════════════════════════════════════════════════════════════════════
-- PASO 1: Eliminar datos transaccionales y eventos (solo tablas existentes)
-- ═══════════════════════════════════════════════════════════════════════════

TRUNCATE TABLE sales CASCADE;
TRUNCATE TABLE expenses CASCADE;
TRUNCATE TABLE purchases CASCADE;
TRUNCATE TABLE cash_cuts CASCADE;
TRUNCATE TABLE shifts CASCADE;
TRUNCATE TABLE guardian_events CASCADE;
TRUNCATE TABLE backup_metadata CASCADE;
TRUNCATE TABLE sessions CASCADE;

-- ═══════════════════════════════════════════════════════════════════════════
-- PASO 2: Eliminar relaciones de empleados
-- ═══════════════════════════════════════════════════════════════════════════

TRUNCATE TABLE employee_branches CASCADE;
TRUNCATE TABLE devices CASCADE;

-- ═══════════════════════════════════════════════════════════════════════════
-- PASO 3: Eliminar empleados
-- ═══════════════════════════════════════════════════════════════════════════

TRUNCATE TABLE employees CASCADE;

-- ═══════════════════════════════════════════════════════════════════════════
-- PASO 4: Eliminar sucursales
-- ═══════════════════════════════════════════════════════════════════════════

TRUNCATE TABLE branches CASCADE;

-- ═══════════════════════════════════════════════════════════════════════════
-- PASO 5: Eliminar tenants (negocios)
-- ═══════════════════════════════════════════════════════════════════════════

TRUNCATE TABLE tenants CASCADE;

-- ═══════════════════════════════════════════════════════════════════════════
-- PASO 6: Resetear secuencias de IDs para comenzar desde 1
-- ═══════════════════════════════════════════════════════════════════════════

ALTER SEQUENCE tenants_id_seq RESTART WITH 1;
ALTER SEQUENCE branches_id_seq RESTART WITH 1;
ALTER SEQUENCE employees_id_seq RESTART WITH 1;
ALTER SEQUENCE employee_branches_id_seq RESTART WITH 1;
ALTER SEQUENCE devices_id_seq RESTART WITH 1;
ALTER SEQUENCE sales_id_seq RESTART WITH 1;
ALTER SEQUENCE expenses_id_seq RESTART WITH 1;
ALTER SEQUENCE purchases_id_seq RESTART WITH 1;
ALTER SEQUENCE cash_cuts_id_seq RESTART WITH 1;
ALTER SEQUENCE shifts_id_seq RESTART WITH 1;
ALTER SEQUENCE guardian_events_id_seq RESTART WITH 1;
ALTER SEQUENCE backup_metadata_id_seq RESTART WITH 1;

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
    (SELECT COUNT(*) FROM sales) as sales;

SELECT 
    'Tablas maestras preservadas:' as mensaje,
    (SELECT COUNT(*) FROM subscriptions) as subscriptions;
