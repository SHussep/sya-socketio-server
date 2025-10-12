-- Migración 007: Sistema de Backup en la Nube
-- =============================================
-- Tabla para almacenar metadata de backups automáticos
-- Desktop sube backups a Dropbox y registra metadata aquí
-- Permite restaurar desde la nube en cualquier PC

-- 1. Crear tabla backup_metadata
CREATE TABLE IF NOT EXISTS backup_metadata (
    id SERIAL PRIMARY KEY,

    -- Relaciones
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE SET NULL,

    -- Información del backup
    backup_filename VARCHAR(255) NOT NULL,
    backup_path TEXT NOT NULL, -- Ruta en Dropbox
    file_size_bytes BIGINT NOT NULL,

    -- Metadata del dispositivo
    device_name VARCHAR(100),
    device_id VARCHAR(100),

    -- Opciones
    is_automatic BOOLEAN DEFAULT true,
    encryption_enabled BOOLEAN DEFAULT true,

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE DEFAULT (NOW() + INTERVAL '90 days'),

    -- Constraints
    CONSTRAINT chk_file_size CHECK (file_size_bytes > 0),
    CONSTRAINT chk_backup_path CHECK (backup_path <> '')
);

-- 2. Crear índices para búsqueda rápida
CREATE INDEX idx_backup_branch_date ON backup_metadata(branch_id, created_at DESC);
CREATE INDEX idx_backup_tenant_date ON backup_metadata(tenant_id, created_at DESC);
CREATE INDEX idx_backup_device ON backup_metadata(device_id);
CREATE INDEX idx_backup_expires ON backup_metadata(expires_at);

-- 3. Agregar comentarios
COMMENT ON TABLE backup_metadata IS 'Metadata de backups automáticos almacenados en Dropbox';
COMMENT ON COLUMN backup_metadata.backup_path IS 'Ruta del archivo en Dropbox (ej: /SYA Backups/backup_20251012.zip)';
COMMENT ON COLUMN backup_metadata.device_id IS 'Identificador único del dispositivo que creó el backup';
COMMENT ON COLUMN backup_metadata.expires_at IS 'Fecha de expiración automática (90 días por defecto)';

-- 4. Verificación
SELECT
    table_name,
    column_name,
    data_type,
    is_nullable
FROM information_schema.columns
WHERE table_name = 'backup_metadata'
ORDER BY ordinal_position;

-- 5. Crear función para limpiar backups expirados (opcional)
CREATE OR REPLACE FUNCTION cleanup_expired_backups()
RETURNS void AS $$
BEGIN
    DELETE FROM backup_metadata
    WHERE expires_at < NOW();

    RAISE NOTICE 'Backups expirados eliminados';
END;
$$ LANGUAGE plpgsql;

-- 6. Configurar cleanup automático (ejecutar cada día a las 3 AM)
-- Nota: Esto requiere pg_cron extension en PostgreSQL
-- Si no está disponible, ejecutar manualmente o desde backend
-- CREATE EXTENSION IF NOT EXISTS pg_cron;
-- SELECT cron.schedule('cleanup-old-backups', '0 3 * * *', 'SELECT cleanup_expired_backups()');
