-- ═══════════════════════════════════════════════════════════════════════════
-- MIGRACIÓN 003: Remover DEFAULT CURRENT_TIMESTAMP de fechas de sincronización
-- ═══════════════════════════════════════════════════════════════════════════
-- PROBLEMA: Las columnas sale_date, expense_date, purchase_date, cash_cut_date,
-- event_date usaban CURRENT_TIMESTAMP del servidor, ignorando la zona horaria del cliente
-- SOLUCIÓN: Remover DEFAULT para FORZAR que el cliente envíe siempre la fecha con zona horaria correcta

BEGIN;

-- 1. ALTER sale_date en tabla sales
-- Redefine sin DEFAULT para que SIEMPRE venga del cliente
ALTER TABLE sales
DROP DEFAULT,
ALTER COLUMN sale_date SET NOT NULL;

-- 2. ALTER expense_date en tabla expenses
ALTER TABLE expenses
DROP DEFAULT,
ALTER COLUMN expense_date SET NOT NULL;

-- 3. ALTER purchase_date en tabla purchases
ALTER TABLE purchases
DROP DEFAULT,
ALTER COLUMN purchase_date SET NOT NULL;

-- 4. ALTER cut_date en tabla cash_cuts
ALTER TABLE cash_cuts
DROP DEFAULT,
ALTER COLUMN cut_date SET NOT NULL;

-- 5. ALTER event_date en tabla guardian_events
ALTER TABLE guardian_events
DROP DEFAULT,
ALTER COLUMN event_date SET NOT NULL;

-- 6. Para registros existentes (que tengan NULL), asignarles el valor actual con UTC
-- Esto solo afecta registros viejos que no tenían fecha
UPDATE sales SET sale_date = CURRENT_TIMESTAMP WHERE sale_date IS NULL;
UPDATE expenses SET expense_date = CURRENT_TIMESTAMP WHERE expense_date IS NULL;
UPDATE purchases SET purchase_date = CURRENT_TIMESTAMP WHERE purchase_date IS NULL;
UPDATE cash_cuts SET cut_date = CURRENT_TIMESTAMP WHERE cut_date IS NULL;
UPDATE guardian_events SET event_date = CURRENT_TIMESTAMP WHERE event_date IS NULL;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- IMPACTO:
-- ═══════════════════════════════════════════════════════════════════════════
-- ✅ Todas las ventas, gastos, compras, cortes y eventos DEBEN incluir la fecha
-- ✅ La fecha viene CON INFORMACIÓN DE ZONA HORARIA desde el cliente
-- ✅ PostgreSQL respeta la zona horaria del cliente, no usa CURRENT_TIMESTAMP del servidor
-- ✅ Cuando consultemos: SELECT sale_date AT TIME ZONE 'America/Mexico_City'
--    nos dará la hora correcta en la zona horaria del usuario
-- ═══════════════════════════════════════════════════════════════════════════
