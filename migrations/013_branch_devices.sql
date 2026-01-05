-- ═══════════════════════════════════════════════════════════════════════════
-- MIGRATION: Create branch_devices table
-- Tracks devices per branch and their role (Primary/Auxiliar)
-- ═══════════════════════════════════════════════════════════════════════════

-- Crear tabla de dispositivos por sucursal
CREATE TABLE IF NOT EXISTS branch_devices (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    device_id VARCHAR(255) NOT NULL,  -- UUID del dispositivo
    device_name VARCHAR(255),          -- Nombre amigable (ej: "PC Caja 1")
    device_type VARCHAR(50),           -- Tipo: "desktop", "tablet", "mobile"
    is_primary BOOLEAN DEFAULT FALSE,  -- Solo uno puede ser Primary por sucursal
    claimed_at TIMESTAMPTZ,            -- Cuándo reclamó el rol Primary
    last_seen_at TIMESTAMPTZ,          -- Última actividad del dispositivo
    employee_id INTEGER REFERENCES employees(id), -- Empleado que reclamó (opcional)
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Índice único para evitar duplicados de dispositivo en la misma sucursal/tenant
CREATE UNIQUE INDEX IF NOT EXISTS idx_branch_devices_unique
ON branch_devices(device_id, branch_id, tenant_id);

-- Índice para búsquedas por sucursal
CREATE INDEX IF NOT EXISTS idx_branch_devices_branch
ON branch_devices(branch_id, tenant_id);

-- Índice parcial para el dispositivo Primary (solo uno por sucursal)
-- Esto es un constraint "soft" - la lógica de la app maneja el reemplazo
CREATE INDEX IF NOT EXISTS idx_branch_devices_primary
ON branch_devices(branch_id, tenant_id) WHERE is_primary = TRUE;

-- Comentarios para documentación
COMMENT ON TABLE branch_devices IS 'Registro de dispositivos por sucursal con rol Primary/Auxiliar';
COMMENT ON COLUMN branch_devices.is_primary IS 'Solo un dispositivo puede ser Primary por sucursal. El Primary tiene acceso completo.';
COMMENT ON COLUMN branch_devices.device_id IS 'UUID único del dispositivo generado localmente';
COMMENT ON COLUMN branch_devices.claimed_at IS 'Timestamp cuando el dispositivo reclamó rol Primary';

-- ═══════════════════════════════════════════════════════════════════════════
-- TRIGGER: Actualizar updated_at automáticamente
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION update_branch_devices_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_branch_devices_updated_at ON branch_devices;
CREATE TRIGGER trigger_branch_devices_updated_at
    BEFORE UPDATE ON branch_devices
    FOR EACH ROW
    EXECUTE FUNCTION update_branch_devices_updated_at();
