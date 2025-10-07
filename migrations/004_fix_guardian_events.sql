-- Migración 004: Fix guardian_events table
-- Fecha: 2025-10-07
-- Propósito: Agregar columna event_date si no existe y recrear índices

-- Agregar columna event_date si no existe
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'guardian_events' AND column_name = 'event_date'
    ) THEN
        ALTER TABLE guardian_events ADD COLUMN event_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

        -- Si la tabla ya tiene datos, copiar created_at a event_date
        UPDATE guardian_events SET event_date = created_at WHERE event_date IS NULL;
    END IF;
END $$;

-- Eliminar índices antiguos si existen
DROP INDEX IF EXISTS idx_guardian_events_date;
DROP INDEX IF EXISTS idx_guardian_events_unread;

-- Recrear índices
CREATE INDEX IF NOT EXISTS idx_guardian_events_date ON guardian_events(event_date DESC);
CREATE INDEX IF NOT EXISTS idx_guardian_events_unread ON guardian_events(tenant_id, is_read) WHERE is_read = false;

-- Verificar estructura final
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'guardian_events'
ORDER BY ordinal_position;
