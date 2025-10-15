-- ═══════════════════════════════════════════════════════════════════════════
-- MIGRACIÓN 002: Agregar tabla backup_metadata para sistema de backups
-- ═══════════════════════════════════════════════════════════════════════════
-- Esta tabla almacena metadata de backups subidos a Dropbox desde Desktop
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- BACKUP_METADATA (Metadata de backups en Dropbox)
CREATE TABLE IF NOT EXISTS backup_metadata (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  backup_filename VARCHAR NOT NULL,
  backup_path VARCHAR NOT NULL UNIQUE,
  file_size_bytes BIGINT NOT NULL DEFAULT 0,
  device_name VARCHAR NOT NULL,
  device_id VARCHAR NOT NULL,
  is_automatic BOOLEAN DEFAULT TRUE,
  encryption_enabled BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP DEFAULT (CURRENT_TIMESTAMP + INTERVAL '90 days')
);

-- ÍNDICES para backup_metadata
CREATE INDEX idx_backup_metadata_tenant_branch ON backup_metadata(tenant_id, branch_id);
CREATE INDEX idx_backup_metadata_created_at ON backup_metadata(created_at DESC);
CREATE INDEX idx_backup_metadata_expires_at ON backup_metadata(expires_at);

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- RESUMEN: 1 TABLA AGREGADA
-- ═══════════════════════════════════════════════════════════════════════════
-- backup_metadata - Metadata de backups subidos a Dropbox
-- ═══════════════════════════════════════════════════════════════════════════
