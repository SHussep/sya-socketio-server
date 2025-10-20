-- ═══════════════════════════════════════════════════════════════════════════
-- Migración 013: Crear tabla de dispositivos autorizados
-- ═══════════════════════════════════════════════════════════════════════════
-- Fecha: 2025-10-19
-- Descripción: Crea tabla para rastrear dispositivos autorizados por sucursal
--              y evitar que un usuario se autentique en múltiples PCs
--              saltándose las licencias.
-- ═══════════════════════════════════════════════════════════════════════════

-- Eliminar tabla antigua si existe
DROP TABLE IF EXISTS devices CASCADE;

-- Crear nueva tabla con esquema completo
CREATE TABLE devices (
    id SERIAL PRIMARY KEY,
    device_id VARCHAR(255) UNIQUE NOT NULL,
    device_name VARCHAR(255),
    device_type VARCHAR(50) DEFAULT 'desktop',
    
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    
    is_active BOOLEAN DEFAULT true,
    is_primary BOOLEAN DEFAULT false,
    
    last_login_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    ip_address VARCHAR(50),
    user_agent TEXT,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deactivated_at TIMESTAMP,
    
    CONSTRAINT unique_device_per_branch UNIQUE(device_id, branch_id)
);

CREATE INDEX IF NOT EXISTS idx_devices_tenant ON devices(tenant_id);
CREATE INDEX IF NOT EXISTS idx_devices_branch ON devices(branch_id);
CREATE INDEX IF NOT EXISTS idx_devices_employee ON devices(employee_id);
CREATE INDEX IF NOT EXISTS idx_devices_active ON devices(is_active);

CREATE OR REPLACE FUNCTION update_devices_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_devices_updated_at
    BEFORE UPDATE ON devices
    FOR EACH ROW
    EXECUTE FUNCTION update_devices_updated_at();

COMMENT ON TABLE devices IS 'Dispositivos autorizados por sucursal para control de licencias';
COMMENT ON COLUMN devices.device_id IS 'ID único del dispositivo (hardware-based)';
COMMENT ON COLUMN devices.is_primary IS 'Solo un dispositivo puede ser primario por sucursal';
COMMENT ON COLUMN devices.is_active IS 'Indica si el dispositivo está actualmente autorizado';
