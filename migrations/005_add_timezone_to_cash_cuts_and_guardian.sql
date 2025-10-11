-- Migración 005: Agregar timezone a cash_cuts y guardian_events timestamps restantes
-- =====================================================================================
-- MEGA IMPORTANTE: Guardian events necesita timestamp exacto del momento del evento
-- Cash cuts necesita timestamp exacto del momento del corte

-- 1. cash_cuts.cut_date - Fecha/hora exacta del corte de caja
ALTER TABLE cash_cuts
ALTER COLUMN cut_date TYPE TIMESTAMP WITH TIME ZONE
USING cut_date AT TIME ZONE 'America/Mexico_City';

-- 2. cash_cuts.created_at - Cuándo se creó el registro
ALTER TABLE cash_cuts
ALTER COLUMN created_at TYPE TIMESTAMP WITH TIME ZONE
USING created_at AT TIME ZONE 'America/Mexico_City';

-- 3. guardian_events.created_at - Cuándo se creó el registro del evento
ALTER TABLE guardian_events
ALTER COLUMN created_at TYPE TIMESTAMP WITH TIME ZONE
USING created_at AT TIME ZONE 'America/Mexico_City';

-- 4. guardian_events.resolved_at - Cuándo se resolvió el evento
ALTER TABLE guardian_events
ALTER COLUMN resolved_at TYPE TIMESTAMP WITH TIME ZONE
USING resolved_at AT TIME ZONE 'America/Mexico_City';

-- 5. Actualizar DEFAULT values para usar CURRENT_TIMESTAMP (ya incluye timezone)
ALTER TABLE cash_cuts
ALTER COLUMN cut_date SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE cash_cuts
ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE guardian_events
ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP;

-- Verificación
SELECT
    table_name,
    column_name,
    data_type,
    column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('cash_cuts', 'guardian_events')
  AND (column_name LIKE '%date%' OR column_name LIKE '%time%' OR column_name = 'created_at' OR column_name = 'resolved_at')
ORDER BY table_name, column_name;

-- Notas:
-- - guardian_events.event_date YA tenía TIMESTAMP WITH TIME ZONE (correcto)
-- - Ahora todos los timestamps críticos tienen timezone
-- - Los eventos Guardian ahora capturan el momento exacto en que ocurrió el evento
-- - Los cortes de caja capturan el momento exacto en que se hizo el corte
