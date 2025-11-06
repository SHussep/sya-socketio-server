-- =====================================================
-- Migration: 058_enhance_devices_for_licensing.sql
-- Descripción: Mejorar tabla devices para control de licencias desde servidor
-- =====================================================
-- Sistema de licencias por dispositivo:
-- - Servidor controla cuántos dispositivos puede tener un tenant
-- - Handshake valida device_uid contra cupo (subscriptions.max_devices)
-- - Campo is_authorized permite revocar acceso sin eliminar registro
-- - features_snapshot guarda snapshot de features al momento del handshake
-- =====================================================

-- ========== AGREGAR COLUMNAS A devices ==========

-- device_uid: Identificador único del dispositivo (hardware)
ALTER TABLE devices
ADD COLUMN IF NOT EXISTS device_uid VARCHAR(255);

-- is_authorized: Control de autorización desde servidor
ALTER TABLE devices
ADD COLUMN IF NOT EXISTS is_authorized BOOLEAN NOT NULL DEFAULT FALSE;

-- features_snapshot: Snapshot de features del plan al momento del handshake
ALTER TABLE devices
ADD COLUMN IF NOT EXISTS features_snapshot JSONB;

-- last_seen_at: Última vez que el dispositivo hizo ping
ALTER TABLE devices
ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;

-- device_name: Nombre del dispositivo (ej: "Terminal 1", "Tablet Repartidor")
ALTER TABLE devices
ADD COLUMN IF NOT EXISTS device_name VARCHAR(255);

-- platform_version: Versión del sistema operativo
ALTER TABLE devices
ADD COLUMN IF NOT EXISTS platform_version VARCHAR(100);

-- app_version: Versión de la aplicación instalada
ALTER TABLE devices
ADD COLUMN IF NOT EXISTS app_version VARCHAR(50);

-- ========== AGREGAR COLUMNAS A tenants ==========

-- max_devices_override: Permite excepciones puntuales al límite del plan
ALTER TABLE tenants
ADD COLUMN IF NOT EXISTS max_devices_override INTEGER;

-- ========== ÍNDICES ==========

-- device_uid UNIQUE para prevenir dispositivos duplicados
CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_device_uid_unique ON devices(device_uid)
  WHERE device_uid IS NOT NULL;

-- Búsqueda de dispositivos autorizados
CREATE INDEX IF NOT EXISTS idx_devices_authorized ON devices(tenant_id, is_authorized)
  WHERE is_authorized = TRUE;

-- Búsqueda por branch y autorización
CREATE INDEX IF NOT EXISTS idx_devices_branch_authorized ON devices(branch_id, is_authorized)
  WHERE is_authorized = TRUE;

-- Dispositivos activos recientemente (para monitoreo)
CREATE INDEX IF NOT EXISTS idx_devices_last_seen ON devices(tenant_id, last_seen_at)
  WHERE is_authorized = TRUE;

-- ========== COMENTARIOS ==========
COMMENT ON COLUMN devices.device_uid IS 'Identificador único del dispositivo (hardware ID, IMEI, etc.)';
COMMENT ON COLUMN devices.is_authorized IS 'TRUE si el dispositivo está autorizado - servidor controla según plan';
COMMENT ON COLUMN devices.features_snapshot IS 'Snapshot de features del plan al momento del handshake (evita cambios retroactivos)';
COMMENT ON COLUMN devices.last_seen_at IS 'Última vez que el dispositivo hizo ping/sync';
COMMENT ON COLUMN devices.device_name IS 'Nombre amigable del dispositivo (ej: Terminal 1, Tablet Repartidor)';
COMMENT ON COLUMN devices.platform_version IS 'Versión del sistema operativo (ej: Windows 11, Android 13)';
COMMENT ON COLUMN devices.app_version IS 'Versión de la aplicación instalada (ej: 1.0.5)';

COMMENT ON COLUMN tenants.max_devices_override IS 'Límite de dispositivos override - anula subscriptions.max_devices si está definido';

-- ========== ACTUALIZAR REGISTROS EXISTENTES ==========
-- Marcar dispositivos existentes como autorizados por defecto (migración legacy)
UPDATE devices
SET is_authorized = TRUE,
    last_seen_at = COALESCE(last_active, created_at)
WHERE is_authorized IS NULL;
