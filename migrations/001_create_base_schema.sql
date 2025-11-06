-- =====================================================
-- Migration: 001_create_base_schema.sql
-- Descripción: Crear esquema base completo (tablas principales)
-- =====================================================
-- Este migration crea TODAS las tablas base necesarias para que
-- las migraciones posteriores (003-060) puedan agregar columnas/índices
-- =====================================================

-- ========== TABLA: subscriptions (planes de suscripción) ==========
CREATE TABLE IF NOT EXISTS subscriptions (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE,
    max_branches INTEGER NOT NULL DEFAULT 1,
    max_devices INTEGER NOT NULL DEFAULT 1,
    max_employees INTEGER,
    features JSONB,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ========== TABLA: tenants (empresas/organizaciones) ==========
CREATE TABLE IF NOT EXISTS tenants (
    id SERIAL PRIMARY KEY,
    tenant_code VARCHAR(50) UNIQUE NOT NULL,
    business_name VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    phone_number VARCHAR(50),
    subscription_id INTEGER REFERENCES subscriptions(id),
    subscription_status VARCHAR(50) DEFAULT 'trial',
    trial_ends_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ========== TABLA: branches (sucursales) ==========
CREATE TABLE IF NOT EXISTS branches (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_code VARCHAR(50) NOT NULL,
    name VARCHAR(255) NOT NULL,
    address TEXT,
    phone VARCHAR(50),
    timezone VARCHAR(50) DEFAULT 'America/Mexico_City',
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(tenant_id, branch_code)
);

-- ========== TABLA: employees (empleados) ==========
CREATE TABLE IF NOT EXISTS employees (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    username VARCHAR(100) NOT NULL,
    first_name VARCHAR(100),
    last_name VARCHAR(100),
    email VARCHAR(255),
    password_hash VARCHAR(255),
    role_id INTEGER,
    is_active BOOLEAN DEFAULT TRUE,
    is_owner BOOLEAN DEFAULT FALSE,
    mobile_access_type VARCHAR(50) DEFAULT 'none',
    can_use_mobile_app BOOLEAN DEFAULT FALSE,
    google_user_identifier VARCHAR(255),
    main_branch_id INTEGER REFERENCES branches(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(tenant_id, username),
    UNIQUE(tenant_id, email)
);

-- ========== TABLA: employee_branches (empleados asignados a sucursales) ==========
CREATE TABLE IF NOT EXISTS employee_branches (
    id SERIAL PRIMARY KEY,
    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    can_login BOOLEAN DEFAULT TRUE,
    can_sell BOOLEAN DEFAULT TRUE,
    can_manage_inventory BOOLEAN DEFAULT FALSE,
    can_close_shift BOOLEAN DEFAULT FALSE,
    assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    removed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(employee_id, branch_id)
);

-- ========== TABLA: devices (dispositivos registrados) ==========
CREATE TABLE IF NOT EXISTS devices (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id INTEGER REFERENCES branches(id) ON DELETE SET NULL,
    employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    device_type VARCHAR(50) NOT NULL,
    platform VARCHAR(50),
    device_token TEXT,
    last_active TIMESTAMP,
    linked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ========== TABLA: sessions (sesiones de usuario) ==========
CREATE TABLE IF NOT EXISTS sessions (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    access_token TEXT NOT NULL,
    refresh_token TEXT,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ========== TABLA: shifts (turnos de empleados) ==========
CREATE TABLE IF NOT EXISTS shifts (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    start_time TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    end_time TIMESTAMP WITH TIME ZONE,
    initial_amount DECIMAL(10, 2) DEFAULT 0,
    final_amount DECIMAL(10, 2),
    is_cash_cut_open BOOLEAN DEFAULT TRUE,
    transaction_counter INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ========== TABLA: expense_categories (categorías de gastos) ==========
CREATE TABLE IF NOT EXISTS expense_categories (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ========== TABLA: expenses (gastos) ==========
CREATE TABLE IF NOT EXISTS expenses (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    category_id INTEGER REFERENCES expense_categories(id) ON DELETE SET NULL,
    description TEXT,
    amount DECIMAL(10, 2) NOT NULL,
    expense_date TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ========== TABLA: deposits (depósitos) ==========
CREATE TABLE IF NOT EXISTS deposits (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    shift_id INTEGER REFERENCES shifts(id) ON DELETE CASCADE,
    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    amount DECIMAL(10, 2) NOT NULL,
    notes TEXT,
    deposit_date TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ========== TABLA: withdrawals (retiros) ==========
CREATE TABLE IF NOT EXISTS withdrawals (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    shift_id INTEGER REFERENCES shifts(id) ON DELETE CASCADE,
    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    amount DECIMAL(10, 2) NOT NULL,
    reason TEXT,
    withdrawal_date TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ========== TABLA: cash_cuts (cortes de caja) ==========
CREATE TABLE IF NOT EXISTS cash_cuts (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    cut_number VARCHAR(50) NOT NULL,
    total_sales DECIMAL(10, 2) NOT NULL,
    total_expenses DECIMAL(10, 2) NOT NULL,
    cash_in_drawer DECIMAL(10, 2) NOT NULL,
    expected_cash DECIMAL(10, 2) NOT NULL,
    difference DECIMAL(10, 2) DEFAULT 0,
    cut_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(tenant_id, cut_number)
);

-- ========== TABLA: backup_metadata (metadatos de respaldos) ==========
CREATE TABLE IF NOT EXISTS backup_metadata (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id INTEGER REFERENCES branches(id) ON DELETE CASCADE,
    employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    backup_filename VARCHAR(255) NOT NULL,
    backup_path TEXT NOT NULL,
    file_size_bytes BIGINT,
    device_name VARCHAR(255),
    device_id VARCHAR(255),
    is_automatic BOOLEAN DEFAULT FALSE,
    encryption_enabled BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ========== ÍNDICES BÁSICOS ==========
CREATE INDEX IF NOT EXISTS idx_employees_tenant_id ON employees(tenant_id);
CREATE INDEX IF NOT EXISTS idx_employees_email ON employees(email);
CREATE INDEX IF NOT EXISTS idx_devices_tenant_id ON devices(tenant_id);
CREATE INDEX IF NOT EXISTS idx_sessions_tenant_id ON sessions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_branches_tenant_id ON branches(tenant_id);
CREATE INDEX IF NOT EXISTS idx_expenses_tenant_id ON expenses(tenant_id);
CREATE INDEX IF NOT EXISTS idx_expenses_branch_id ON expenses(branch_id);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(expense_date DESC);
CREATE INDEX IF NOT EXISTS idx_cash_cuts_tenant_id ON cash_cuts(tenant_id);
CREATE INDEX IF NOT EXISTS idx_cash_cuts_branch_id ON cash_cuts(branch_id);

-- ========== DATOS INICIALES: Subscriptions ==========
INSERT INTO subscriptions (name, max_branches, max_devices, max_employees, is_active)
VALUES
    ('Basic', 1, 2, 10, true),
    ('Pro', 5, 10, 50, true),
    ('Enterprise', 999, 999, 999, true)
ON CONFLICT (name) DO NOTHING;

-- ========== COMENTARIOS ==========
COMMENT ON TABLE tenants IS 'Empresas/organizaciones multi-tenant';
COMMENT ON TABLE branches IS 'Sucursales por tenant';
COMMENT ON TABLE employees IS 'Empleados con acceso al sistema';
COMMENT ON TABLE shifts IS 'Turnos de trabajo de empleados';
COMMENT ON TABLE expenses IS 'Gastos registrados por sucursal';
COMMENT ON TABLE deposits IS 'Depósitos de efectivo';
COMMENT ON TABLE withdrawals IS 'Retiros de efectivo';
COMMENT ON TABLE backup_metadata IS 'Metadatos de respaldos en Dropbox';

-- Log de finalización
DO $$
BEGIN
    RAISE NOTICE '✅ Migration 001 completada: Esquema base creado';
END $$;
