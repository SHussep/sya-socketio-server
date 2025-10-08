-- ============================================================================
-- MIGRACIÓN 004: AGREGAR COLUMNAS FALTANTES A GUARDIAN_EVENTS
-- ============================================================================

-- Agregar columnas weight_kg y scale_id si no existen
ALTER TABLE guardian_events ADD COLUMN IF NOT EXISTS weight_kg DECIMAL(10, 3);
ALTER TABLE guardian_events ADD COLUMN IF NOT EXISTS scale_id VARCHAR(100);

-- Comentarios
COMMENT ON COLUMN guardian_events.weight_kg IS 'Peso en kilogramos detectado por la báscula';
COMMENT ON COLUMN guardian_events.scale_id IS 'Identificador de la báscula que detectó el evento';
