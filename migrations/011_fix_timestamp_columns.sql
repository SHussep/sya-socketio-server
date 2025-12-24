-- ═══════════════════════════════════════════════════════════════
-- MIGRACIÓN: Convertir columnas de fecha a timestamp with time zone
-- ═══════════════════════════════════════════════════════════════
-- Problema: expense_date y purchase_date son 'timestamp without time zone'
-- pero almacenan valores en UTC. Esto causa problemas con AT TIME ZONE.
--
-- Solución: Convertir a 'timestamp with time zone' (timestamptz)
-- PostgreSQL interpretará los valores existentes como UTC.
-- ═══════════════════════════════════════════════════════════════

-- 1. Convertir expense_date a timestamptz
ALTER TABLE expenses
ALTER COLUMN expense_date TYPE timestamp with time zone
USING expense_date AT TIME ZONE 'UTC';

-- 2. Convertir purchase_date a timestamptz
ALTER TABLE purchases
ALTER COLUMN purchase_date TYPE timestamp with time zone
USING purchase_date AT TIME ZONE 'UTC';

-- Verificar los cambios
SELECT table_name, column_name, data_type, udt_name
FROM information_schema.columns
WHERE (table_name = 'expenses' AND column_name = 'expense_date')
   OR (table_name = 'purchases' AND column_name = 'purchase_date');
