-- ═══════════════════════════════════════════════════════════════════════════
-- MIGRACIÓN: Mejoras al Modo Alistamiento (Preparation Mode v2)
-- ═══════════════════════════════════════════════════════════════════════════
-- Agrega campos de justificación, ventanas horarias y notificaciones
-- para prevenir abuso del Modo Alistamiento.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Nuevos campos en preparation_mode_logs
ALTER TABLE preparation_mode_logs ADD COLUMN IF NOT EXISTS fuera_de_ventana BOOLEAN DEFAULT FALSE;
ALTER TABLE preparation_mode_logs ADD COLUMN IF NOT EXISTS razon_activacion TEXT;
ALTER TABLE preparation_mode_logs ADD COLUMN IF NOT EXISTS razon_cierre TEXT;
ALTER TABLE preparation_mode_logs ADD COLUMN IF NOT EXISTS requirio_justificacion_activacion BOOLEAN DEFAULT FALSE;
ALTER TABLE preparation_mode_logs ADD COLUMN IF NOT EXISTS requirio_justificacion_cierre BOOLEAN DEFAULT FALSE;
ALTER TABLE preparation_mode_logs ADD COLUMN IF NOT EXISTS notificacion_enviada BOOLEAN DEFAULT FALSE;

-- 2. Tabla de ventanas horarias permitidas para alistamiento
CREATE TABLE IF NOT EXISTS preparation_mode_windows (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_prep_windows_tenant_branch
    ON preparation_mode_windows(tenant_id, branch_id);

-- 3. Trigger para updated_at en ventanas
CREATE OR REPLACE FUNCTION update_preparation_mode_windows_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_prep_windows_updated_at ON preparation_mode_windows;
CREATE TRIGGER trigger_prep_windows_updated_at
    BEFORE UPDATE ON preparation_mode_windows
    FOR EACH ROW
    EXECUTE FUNCTION update_preparation_mode_windows_updated_at();

-- 4. Comentarios
COMMENT ON TABLE preparation_mode_windows IS 'Ventanas horarias permitidas para activar alistamiento sin justificación obligatoria';
COMMENT ON COLUMN preparation_mode_logs.fuera_de_ventana IS 'True si se activó fuera de las ventanas horarias configuradas';
COMMENT ON COLUMN preparation_mode_logs.razon_activacion IS 'Justificación obligatoria al activar fuera de ventana o como admin';
COMMENT ON COLUMN preparation_mode_logs.razon_cierre IS 'Justificación obligatoria al cerrar sesiones menores a 5 minutos';
COMMENT ON COLUMN preparation_mode_logs.notificacion_enviada IS 'True si se envió push notification al dueño por esta sesión';
