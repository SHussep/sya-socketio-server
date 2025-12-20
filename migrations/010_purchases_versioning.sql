-- ═══════════════════════════════════════════════════════════════
-- MIGRACIÓN: Agregar columnas de versionamiento a purchases
-- Fecha: 2025-12-20
-- Propósito: Soporte para detección de conflictos en sincronización bidireccional
-- ═══════════════════════════════════════════════════════════════

DO $$
BEGIN
    -- sync_version: Versión del registro para detección de conflictos
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'purchases' AND column_name = 'sync_version') THEN
        ALTER TABLE purchases ADD COLUMN sync_version INTEGER DEFAULT 1;
        COMMENT ON COLUMN purchases.sync_version IS 'Versión del registro, se incrementa con cada modificación para detectar conflictos';
    END IF;

    -- has_conflict: Indica si hay conflicto detectado
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'purchases' AND column_name = 'has_conflict') THEN
        ALTER TABLE purchases ADD COLUMN has_conflict BOOLEAN DEFAULT FALSE;
        COMMENT ON COLUMN purchases.has_conflict IS 'TRUE si hay conflicto de sincronización pendiente de resolver';
    END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════
-- Trigger para auto-incrementar sync_version en cada UPDATE
-- ═══════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION increment_purchase_sync_version()
RETURNS TRIGGER AS $$
BEGIN
    -- Solo incrementar si no es una actualización de sync (evitar ciclos)
    IF OLD.updated_at IS DISTINCT FROM NEW.updated_at THEN
        NEW.sync_version := COALESCE(OLD.sync_version, 0) + 1;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Eliminar trigger si existe y recrear
DROP TRIGGER IF EXISTS trg_purchases_sync_version ON purchases;
CREATE TRIGGER trg_purchases_sync_version
    BEFORE UPDATE ON purchases
    FOR EACH ROW
    EXECUTE FUNCTION increment_purchase_sync_version();

-- ═══════════════════════════════════════════════════════════════
-- Verificación
-- ═══════════════════════════════════════════════════════════════
SELECT 'Migración 010_purchases_versioning completada' AS status;
