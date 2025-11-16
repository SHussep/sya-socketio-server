-- ═══════════════════════════════════════════════════════════════
-- SCHEMA DE BASE DE DATOS POSTGRESQL - SYA TORTILLERÍAS
-- ═══════════════════════════════════════════════════════════════

-- Tabla: tenants
CREATE TABLE IF NOT EXISTS tenants (
    id SERIAL PRIMARY KEY,
    tenant_code VARCHAR(20) UNIQUE NOT NULL,
    business_name VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    phone_number VARCHAR(20),
    address TEXT,
    subscription_status VARCHAR(50) DEFAULT 'trial',
    subscription_plan VARCHAR(50) DEFAULT 'basic',
    subscription_ends_at TIMESTAMP,
    trial_ends_at TIMESTAMP,
    max_devices INTEGER DEFAULT 3,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Tabla: employees
CREATE TABLE IF NOT EXISTS employees (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    username VARCHAR(100) NOT NULL,
    full_name VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL,
    password VARCHAR(255) NOT NULL,
    role VARCHAR(50) DEFAULT 'employee',
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(tenant_id, username),
    UNIQUE(tenant_id, email)
);

-- Tabla: devices
CREATE TABLE IF NOT EXISTS devices (
    id VARCHAR(255) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    device_type VARCHAR(50) DEFAULT 'mobile',
    platform VARCHAR(50),
    last_active TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    linked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    is_active BOOLEAN DEFAULT true
);

-- Tabla: sessions
CREATE TABLE IF NOT EXISTS sessions (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    device_id VARCHAR(255) REFERENCES devices(id) ON DELETE CASCADE,
    access_token TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    is_active BOOLEAN DEFAULT true
);

-- Tabla: qr_codes (códigos QR temporales para vinculación)
CREATE TABLE IF NOT EXISTS qr_codes (
    id SERIAL PRIMARY KEY,
    sync_code VARCHAR(100) UNIQUE NOT NULL,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    email VARCHAR(255) NOT NULL,
    signature VARCHAR(255) NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    used BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Índices para mejorar rendimiento
CREATE INDEX IF NOT EXISTS idx_employees_tenant_id ON employees(tenant_id);
CREATE INDEX IF NOT EXISTS idx_employees_email ON employees(email);
CREATE INDEX IF NOT EXISTS idx_devices_tenant_id ON devices(tenant_id);
CREATE INDEX IF NOT EXISTS idx_sessions_tenant_id ON sessions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_sessions_employee_id ON sessions(employee_id);
CREATE INDEX IF NOT EXISTS idx_qr_codes_sync_code ON qr_codes(sync_code);
CREATE INDEX IF NOT EXISTS idx_qr_codes_expires_at ON qr_codes(expires_at);

-- Función para actualizar updated_at automáticamente
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Triggers para actualizar updated_at
DROP TRIGGER IF EXISTS update_tenants_updated_at ON tenants;
CREATE TRIGGER update_tenants_updated_at
    BEFORE UPDATE ON tenants
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_employees_updated_at ON employees;
CREATE TRIGGER update_employees_updated_at
    BEFORE UPDATE ON employees
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Comentarios en las tablas
COMMENT ON TABLE tenants IS 'Organizaciones/empresas que usan el sistema';
COMMENT ON TABLE employees IS 'Empleados de cada organización';
COMMENT ON TABLE devices IS 'Dispositivos móviles vinculados';
COMMENT ON TABLE sessions IS 'Sesiones activas de usuarios';
COMMENT ON TABLE qr_codes IS 'Códigos QR temporales para vinculación de dispositivos';
