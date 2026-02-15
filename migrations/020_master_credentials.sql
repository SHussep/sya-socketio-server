-- ═══════════════════════════════════════════════════════════════
-- MIGRATION 020: Master Credentials (Superusuario)
-- Sistema de acceso maestro para soporte/emergencias
-- ═══════════════════════════════════════════════════════════════

-- Tabla de credenciales maestras (bcrypt hash)
CREATE TABLE IF NOT EXISTS master_credentials (
    id SERIAL PRIMARY KEY,
    username VARCHAR(100) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Tabla de auditoría de intentos de login maestro
CREATE TABLE IF NOT EXISTS master_login_audit (
    id SERIAL PRIMARY KEY,
    username VARCHAR(100) NOT NULL,
    ip_address VARCHAR(45),
    user_agent TEXT,
    success BOOLEAN NOT NULL,
    client_type VARCHAR(20),
    target_tenant_id INTEGER,
    target_branch_id INTEGER,
    failure_reason VARCHAR(255),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_master_login_audit_created ON master_login_audit(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_master_login_audit_username ON master_login_audit(username);

-- Para insertar un superusuario, generar hash bcrypt de 12 rounds:
-- Ejemplo con Node.js: const hash = await bcrypt.hash('tu_contrasena', 12);
-- INSERT INTO master_credentials (username, password_hash) VALUES ('superadmin', '$2a$12$...');
