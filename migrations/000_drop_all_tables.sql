-- ═══════════════════════════════════════════════════════════════════════════
-- MIGRACIÓN 000: Limpiar base de datos - DROP ALL TABLES
-- ═══════════════════════════════════════════════════════════════════════════
-- Fecha: 2025-10-14
-- Descripción: Eliminar todas las tablas para empezar desde cero
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- Drop todas las vistas primero
DROP VIEW IF EXISTS v_sales_complete CASCADE;
DROP VIEW IF EXISTS v_expenses_complete CASCADE;
DROP VIEW IF EXISTS v_purchases_complete CASCADE;
DROP VIEW IF EXISTS v_cash_drawer_sessions_complete CASCADE;
DROP VIEW IF EXISTS v_cash_transactions_complete CASCADE;
DROP VIEW IF EXISTS v_sale_items_complete CASCADE;
DROP VIEW IF EXISTS v_guardian_scores_complete CASCADE;

-- Drop todas las funciones de triggers
DROP FUNCTION IF EXISTS update_sales_updated_at() CASCADE;
DROP FUNCTION IF EXISTS update_expenses_updated_at() CASCADE;
DROP FUNCTION IF EXISTS update_purchases_updated_at() CASCADE;
DROP FUNCTION IF EXISTS update_cash_drawer_updated_at() CASCADE;
DROP FUNCTION IF EXISTS sync_cash_drawer_times() CASCADE;
DROP FUNCTION IF EXISTS update_cash_trans_updated_at() CASCADE;
DROP FUNCTION IF EXISTS update_sale_items_updated_at() CASCADE;
DROP FUNCTION IF EXISTS calculate_sale_item_discount() CASCADE;
DROP FUNCTION IF EXISTS update_guardian_updated_at() CASCADE;
DROP FUNCTION IF EXISTS calculate_guardian_score_band() CASCADE;

-- Drop todas las tablas
DROP TABLE IF EXISTS sale_items CASCADE;
DROP TABLE IF EXISTS sales CASCADE;
DROP TABLE IF EXISTS expenses CASCADE;
DROP TABLE IF EXISTS purchases CASCADE;
DROP TABLE IF EXISTS cash_drawer_sessions CASCADE;
DROP TABLE IF EXISTS cash_transactions CASCADE;
DROP TABLE IF EXISTS guardian_employee_scores CASCADE;
DROP TABLE IF EXISTS delivery_balance_movements CASCADE;
DROP TABLE IF EXISTS shifts CASCADE;
DROP TABLE IF EXISTS employees CASCADE;
DROP TABLE IF EXISTS branches CASCADE;
DROP TABLE IF EXISTS tenants CASCADE;
DROP TABLE IF EXISTS expense_categories CASCADE;
DROP TABLE IF EXISTS payment_types CASCADE;
DROP TABLE IF EXISTS purchase_statuses CASCADE;
DROP TABLE IF EXISTS products CASCADE;
DROP TABLE IF EXISTS proveedores CASCADE;

COMMIT;
