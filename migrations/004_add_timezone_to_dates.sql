-- Migración 004: Agregar timezone a las columnas de fecha
-- ============================================================
-- Las ventas, gastos y compras deben guardarse con la zona horaria
-- del cliente, no del servidor, ya que México tiene diferentes zonas horarias

-- 1. Modificar sales.sale_date
ALTER TABLE sales
ALTER COLUMN sale_date TYPE TIMESTAMP WITH TIME ZONE
USING sale_date AT TIME ZONE 'America/Mexico_City';

-- 2. Modificar expenses.expense_date
ALTER TABLE expenses
ALTER COLUMN expense_date TYPE TIMESTAMP WITH TIME ZONE
USING expense_date AT TIME ZONE 'America/Mexico_City';

-- 3. Modificar purchases.purchase_date (si existe)
ALTER TABLE purchases
ALTER COLUMN purchase_date TYPE TIMESTAMP WITH TIME ZONE
USING purchase_date AT TIME ZONE 'America/Mexico_City';

-- 4. Modificar guardian_events.timestamp (si existe)
ALTER TABLE guardian_events
ALTER COLUMN timestamp TYPE TIMESTAMP WITH TIME ZONE
USING timestamp AT TIME ZONE 'America/Mexico_City';

-- 5. Modificar guardian_events.event_date (si existe)
ALTER TABLE guardian_events
ALTER COLUMN event_date TYPE TIMESTAMP WITH TIME ZONE
USING event_date AT TIME ZONE 'America/Mexico_City';

-- 6. Modificar shifts timestamps
ALTER TABLE shifts
ALTER COLUMN start_time TYPE TIMESTAMP WITH TIME ZONE
USING start_time AT TIME ZONE 'America/Mexico_City';

ALTER TABLE shifts
ALTER COLUMN end_time TYPE TIMESTAMP WITH TIME ZONE
USING end_time AT TIME ZONE 'America/Mexico_City';

-- 7. Actualizar DEFAULT values para usar CURRENT_TIMESTAMP (ya incluye timezone)
ALTER TABLE sales
ALTER COLUMN sale_date SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE expenses
ALTER COLUMN expense_date SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE purchases
ALTER COLUMN purchase_date SET DEFAULT CURRENT_TIMESTAMP;

-- Verificación
SELECT
    table_name,
    column_name,
    data_type,
    column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('sales', 'expenses', 'purchases', 'guardian_events', 'shifts')
  AND column_name LIKE '%date%' OR column_name LIKE '%time%'
ORDER BY table_name, column_name;

-- Notas:
-- - TIMESTAMP WITH TIME ZONE guarda el timestamp en UTC internamente
-- - Cuando insertas con timezone, PostgreSQL convierte automáticamente a UTC
-- - Cuando consultas, PostgreSQL convierte de vuelta a tu timezone configurado
-- - Esto permite que diferentes clientes en diferentes zonas horarias vean la hora correcta
