-- ═══════════════════════════════════════════════════════════════
-- MIGRATION 003: Add Business Tables for Mobile Dashboard
-- ═══════════════════════════════════════════════════════════════

-- Tabla: branches (sucursales)
CREATE TABLE IF NOT EXISTS branches (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_code VARCHAR(20) NOT NULL,
    name VARCHAR(255) NOT NULL,
    address TEXT,
    phone_number VARCHAR(20),
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(tenant_id, branch_code)
);

-- Tabla: sales (ventas - solo resumen para móvil)
CREATE TABLE IF NOT EXISTS sales (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    ticket_number VARCHAR(50) NOT NULL,
    total_amount DECIMAL(10, 2) NOT NULL,
    payment_method VARCHAR(50),
    sale_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(tenant_id, ticket_number)
);

-- Tabla: expenses (gastos)
CREATE TABLE IF NOT EXISTS expenses (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    category VARCHAR(100) NOT NULL,
    description TEXT,
    amount DECIMAL(10, 2) NOT NULL,
    expense_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Tabla: cash_cuts (cortes de caja)
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

-- Tabla: guardian_events (eventos del modo guardián - MUY IMPORTANTE)
CREATE TABLE IF NOT EXISTS guardian_events (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    event_type VARCHAR(50) NOT NULL, -- 'SCALE_CONNECTED', 'SCALE_DISCONNECTED', 'WEIGHT_WITHOUT_SALE', 'SUSPICIOUS_ACTIVITY'
    severity VARCHAR(20) DEFAULT 'medium', -- 'low', 'medium', 'high', 'critical'
    title VARCHAR(255) NOT NULL,
    description TEXT,
    weight_kg DECIMAL(8, 3),
    scale_id VARCHAR(100),
    metadata JSONB, -- Datos adicionales del evento
    is_read BOOLEAN DEFAULT false,
    event_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Índices para performance
CREATE INDEX IF NOT EXISTS idx_branches_tenant_id ON branches(tenant_id);
CREATE INDEX IF NOT EXISTS idx_sales_tenant_id ON sales(tenant_id);
CREATE INDEX IF NOT EXISTS idx_sales_branch_id ON sales(branch_id);
CREATE INDEX IF NOT EXISTS idx_sales_date ON sales(sale_date DESC);
CREATE INDEX IF NOT EXISTS idx_expenses_tenant_id ON expenses(tenant_id);
CREATE INDEX IF NOT EXISTS idx_expenses_branch_id ON expenses(branch_id);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(expense_date DESC);
CREATE INDEX IF NOT EXISTS idx_cash_cuts_tenant_id ON cash_cuts(tenant_id);
CREATE INDEX IF NOT EXISTS idx_cash_cuts_branch_id ON cash_cuts(branch_id);
CREATE INDEX IF NOT EXISTS idx_guardian_events_tenant_id ON guardian_events(tenant_id);
CREATE INDEX IF NOT EXISTS idx_guardian_events_branch_id ON guardian_events(branch_id);
CREATE INDEX IF NOT EXISTS idx_guardian_events_date ON guardian_events(event_date DESC);
CREATE INDEX IF NOT EXISTS idx_guardian_events_unread ON guardian_events(tenant_id, is_read) WHERE is_read = false;

-- Triggers para updated_at
DROP TRIGGER IF EXISTS update_branches_updated_at ON branches;
CREATE TRIGGER update_branches_updated_at
    BEFORE UPDATE ON branches
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Comentarios
COMMENT ON TABLE branches IS 'Sucursales de cada tenant';
COMMENT ON TABLE sales IS 'Resumen de ventas para dashboard móvil';
COMMENT ON TABLE expenses IS 'Gastos registrados por sucursal';
COMMENT ON TABLE cash_cuts IS 'Cortes de caja diarios';
COMMENT ON TABLE guardian_events IS 'Eventos del modo guardián (básculas, actividades sospechosas)';

COMMENT ON COLUMN guardian_events.event_type IS 'SCALE_CONNECTED, SCALE_DISCONNECTED, WEIGHT_WITHOUT_SALE, SUSPICIOUS_ACTIVITY';
COMMENT ON COLUMN guardian_events.severity IS 'low, medium, high, critical';
COMMENT ON COLUMN guardian_events.metadata IS 'JSON con datos adicionales del evento';
