-- ═══════════════════════════════════════════════════════════════
-- CLEANUP SCRIPT - Borrar datos de transacciones (mantener maestros)
-- ═══════════════════════════════════════════════════════════════

-- Desactivar constraints temporalmente
ALTER TABLE sales_items DISABLE TRIGGER ALL;
ALTER TABLE sales DISABLE TRIGGER ALL;
ALTER TABLE expenses DISABLE TRIGGER ALL;
ALTER TABLE cash_cuts DISABLE TRIGGER ALL;
ALTER TABLE guardian_events DISABLE TRIGGER ALL;
ALTER TABLE shifts DISABLE TRIGGER ALL;

-- Borrar datos en orden de dependencias
DELETE FROM sales_items;
DELETE FROM sales;
DELETE FROM expenses;
DELETE FROM cash_cuts;
DELETE FROM guardian_events;
DELETE FROM shifts;

-- Reactivar constraints
ALTER TABLE sales_items ENABLE TRIGGER ALL;
ALTER TABLE sales ENABLE TRIGGER ALL;
ALTER TABLE expenses ENABLE TRIGGER ALL;
ALTER TABLE cash_cuts ENABLE TRIGGER ALL;
ALTER TABLE guardian_events ENABLE TRIGGER ALL;
ALTER TABLE shifts ENABLE TRIGGER ALL;

-- Reset sequences
ALTER SEQUENCE sales_id_seq RESTART WITH 1;
ALTER SEQUENCE sales_items_id_seq RESTART WITH 1;
ALTER SEQUENCE expenses_id_seq RESTART WITH 1;
ALTER SEQUENCE cash_cuts_id_seq RESTART WITH 1;
ALTER SEQUENCE guardian_events_id_seq RESTART WITH 1;
ALTER SEQUENCE shifts_id_seq RESTART WITH 1;

-- Confirmación
SELECT 
    (SELECT COUNT(*) FROM sales) as sales_count,
    (SELECT COUNT(*) FROM sales_items) as sales_items_count,
    (SELECT COUNT(*) FROM expenses) as expenses_count,
    (SELECT COUNT(*) FROM cash_cuts) as cash_cuts_count,
    (SELECT COUNT(*) FROM guardian_events) as guardian_events_count,
    (SELECT COUNT(*) FROM shifts) as shifts_count;

-- ═══════════════════════════════════════════════════════════════
-- Verificar datos maestros intactos
-- ═══════════════════════════════════════════════════════════════
SELECT 'Tenants' as tabla, COUNT(*) as count FROM tenants
UNION ALL
SELECT 'Branches', COUNT(*) FROM branches
UNION ALL
SELECT 'Employees', COUNT(*) FROM employees
UNION ALL
SELECT 'Subscriptions', COUNT(*) FROM subscriptions;
