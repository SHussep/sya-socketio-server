-- ═══════════════════════════════════════════════════════════════
-- Agregar campo reviewed_by_desktop a la tabla expenses
-- ═══════════════════════════════════════════════════════════════
-- INSTRUCCIONES:
-- 1. Este campo debe agregarse en routes/schema-db.sql línea 202-203
-- 2. Agregar DESPUÉS de payment_type_id y ANTES del comentario "-- Soft delete"
--
-- UBICACIÓN EXACTA en schema-db.sql:
--    payment_type_id INTEGER,  -- 1=Efectivo, 2=Tarjeta
--
--    [AGREGAR AQUÍ LAS SIGUIENTES 3 LÍNEAS:]
--    -- Mobile app review system
--    reviewed_by_desktop BOOLEAN DEFAULT FALSE,  -- TRUE = aprobado por Desktop, FALSE = pendiente de revisión
--
--    -- Soft delete
--    is_active BOOLEAN DEFAULT TRUE,
-- ═══════════════════════════════════════════════════════════════

-- Para agregar este campo a una base de datos existente, ejecuta:
ALTER TABLE expenses
ADD COLUMN reviewed_by_desktop BOOLEAN DEFAULT FALSE;

COMMENT ON COLUMN expenses.reviewed_by_desktop IS 'Indica si un gasto registrado desde la app móvil fue revisado y aprobado por Desktop. TRUE = aprobado y guardado en SQLite local, FALSE = pendiente de revisión';

-- Crear índice para buscar gastos pendientes de revisión
CREATE INDEX IF NOT EXISTS idx_expenses_reviewed_by_desktop
ON expenses(employee_id, reviewed_by_desktop)
WHERE reviewed_by_desktop = FALSE;
