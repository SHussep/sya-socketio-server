-- ═══════════════════════════════════════════════════════════════════════════
-- MIGRACIÓN 001: Esquema COMPLETO para Sistema SYA
-- ═══════════════════════════════════════════════════════════════════════════
-- Incluye TODAS las tablas necesarias para Desktop + Mobile + Subscriptions
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. SUBSCRIPTIONS (Planes de suscripción)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE subscriptions (
  id SERIAL PRIMARY KEY,
  name VARCHAR NOT NULL UNIQUE, -- 'Basic', 'Pro', 'Enterprise'
  max_branches INTEGER NOT NULL DEFAULT 1,
  max_devices INTEGER NOT NULL DEFAULT 3,
  price DECIMAL(10,2),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Insertar planes por defecto
INSERT INTO subscriptions (name, max_branches, max_devices, price) VALUES
('Basic', 1, 3, 0),
('Pro', 5, 10, 999),
('Enterprise', 999, 999, 2999);

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. TENANTS (Negocios)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE tenants (
  id SERIAL PRIMARY KEY,
  tenant_code VARCHAR NOT NULL UNIQUE,
  business_name VARCHAR NOT NULL,
  email VARCHAR,
  phone_number VARCHAR,
  address VARCHAR,
  subscription_status VARCHAR DEFAULT 'trial',
  subscription_id INTEGER REFERENCES subscriptions(id),
  trial_ends_at TIMESTAMP,
  subscription_ends_at TIMESTAMP,
  max_devices INTEGER DEFAULT 3,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. BRANCHES (Sucursales)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE branches (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id),
  branch_code VARCHAR NOT NULL,
  name VARCHAR NOT NULL,
  address VARCHAR,
  phone_number VARCHAR,
  timezone VARCHAR DEFAULT 'America/Mexico_City',
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. EMPLOYEES (Empleados)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE employees (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id),
  username VARCHAR NOT NULL,
  full_name VARCHAR NOT NULL,
  email VARCHAR NOT NULL,
  password VARCHAR NOT NULL,
  role VARCHAR DEFAULT 'employee',
  main_branch_id INTEGER,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tenant_id, username)
);

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. EMPLOYEE_BRANCHES (Permisos por sucursal)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE employee_branches (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  can_login BOOLEAN DEFAULT TRUE,
  can_sell BOOLEAN DEFAULT TRUE,
  can_manage_inventory BOOLEAN DEFAULT FALSE,
  can_close_shift BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(employee_id, branch_id)
);

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. DEVICES (Dispositivos móviles)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE devices (
  id VARCHAR PRIMARY KEY,
  name VARCHAR NOT NULL,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id),
  employee_id INTEGER REFERENCES employees(id),
  device_type VARCHAR DEFAULT 'mobile',
  is_active BOOLEAN DEFAULT TRUE,
  linked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_active TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ═══════════════════════════════════════════════════════════════════════════
-- 7. SESSIONS (Sesiones JWT)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE sessions (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id),
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  device_id VARCHAR REFERENCES devices(id),
  token VARCHAR NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ═══════════════════════════════════════════════════════════════════════════
-- 8. SHIFTS (Turnos / Cortes de Caja)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE shifts (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id),
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  employee_id INTEGER REFERENCES employees(id),
  start_time TIMESTAMP NOT NULL,
  end_time TIMESTAMP,
  initial_amount DECIMAL(10,2) DEFAULT 0,
  final_amount DECIMAL(10,2) DEFAULT 0,
  transaction_counter INTEGER DEFAULT 0,
  is_cash_cut_open BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ═══════════════════════════════════════════════════════════════════════════
-- 9. SALES (Ventas)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE sales (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id),
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  employee_id INTEGER REFERENCES employees(id),
  ticket_number INTEGER NOT NULL,
  total_amount DECIMAL(10,2) NOT NULL,
  payment_method VARCHAR,
  sale_type VARCHAR,
  sale_date TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ═══════════════════════════════════════════════════════════════════════════
-- 10. EXPENSE_CATEGORIES (Categorías de gastos)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE expense_categories (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id),
  name VARCHAR NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tenant_id, name)
);

-- ═══════════════════════════════════════════════════════════════════════════
-- 11. EXPENSES (Gastos)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE expenses (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id),
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  employee_id INTEGER REFERENCES employees(id),
  category_id INTEGER REFERENCES expense_categories(id),
  description VARCHAR,
  amount DECIMAL(10,2) NOT NULL,
  expense_date TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ═══════════════════════════════════════════════════════════════════════════
-- 12. SUPPLIERS (Proveedores)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE suppliers (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id),
  name VARCHAR NOT NULL,
  contact_person VARCHAR,
  phone_number VARCHAR,
  email VARCHAR,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ═══════════════════════════════════════════════════════════════════════════
-- 13. PURCHASES (Compras)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE purchases (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id),
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  supplier_id INTEGER REFERENCES suppliers(id),
  employee_id INTEGER REFERENCES employees(id),
  purchase_number VARCHAR NOT NULL,
  total_amount DECIMAL(10,2) NOT NULL,
  payment_status VARCHAR DEFAULT 'pending',
  notes TEXT,
  purchase_date TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ═══════════════════════════════════════════════════════════════════════════
-- 14. CASH_CUTS (Cortes de caja)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE cash_cuts (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id),
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  employee_id INTEGER REFERENCES employees(id),
  cut_number VARCHAR NOT NULL,
  total_sales DECIMAL(10,2) DEFAULT 0,
  total_expenses DECIMAL(10,2) DEFAULT 0,
  cash_in_drawer DECIMAL(10,2) DEFAULT 0,
  expected_cash DECIMAL(10,2) DEFAULT 0,
  difference DECIMAL(10,2) DEFAULT 0,
  cut_date TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ═══════════════════════════════════════════════════════════════════════════
-- 15. GUARDIAN_EVENTS (Eventos Guardian / Báscula)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE guardian_events (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id),
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  employee_id INTEGER REFERENCES employees(id),
  event_type VARCHAR NOT NULL,
  severity VARCHAR NOT NULL,
  title VARCHAR NOT NULL,
  description TEXT NOT NULL,
  weight_kg DECIMAL(10,2),
  scale_id VARCHAR,
  metadata JSONB,
  is_read BOOLEAN DEFAULT FALSE,
  event_date TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ═══════════════════════════════════════════════════════════════════════════
-- 16. BACKUP_METADATA (Metadata de backups en Dropbox)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE backup_metadata (
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

-- ═══════════════════════════════════════════════════════════════════════════
-- ÍNDICES
-- ═══════════════════════════════════════════════════════════════════════════
CREATE INDEX idx_tenants_email ON tenants(email);
CREATE INDEX idx_branches_tenant ON branches(tenant_id);
CREATE INDEX idx_employees_tenant ON employees(tenant_id);
CREATE INDEX idx_employees_email ON employees(email);
CREATE INDEX idx_employee_branches_employee ON employee_branches(employee_id);
CREATE INDEX idx_employee_branches_branch ON employee_branches(branch_id);
CREATE INDEX idx_devices_tenant ON devices(tenant_id);
CREATE INDEX idx_sessions_tenant ON sessions(tenant_id);
CREATE INDEX idx_shifts_tenant_branch ON shifts(tenant_id, branch_id);
CREATE INDEX idx_shifts_employee ON shifts(employee_id);
CREATE INDEX idx_sales_tenant_branch ON sales(tenant_id, branch_id);
CREATE INDEX idx_sales_date ON sales(sale_date);
CREATE INDEX idx_expenses_tenant_branch ON expenses(tenant_id, branch_id);
CREATE INDEX idx_expenses_date ON expenses(expense_date);
CREATE INDEX idx_purchases_tenant_branch ON purchases(tenant_id, branch_id);
CREATE INDEX idx_purchases_date ON purchases(purchase_date);
CREATE INDEX idx_cash_cuts_tenant ON cash_cuts(tenant_id);
CREATE INDEX idx_guardian_tenant_branch ON guardian_events(tenant_id, branch_id);
CREATE INDEX idx_guardian_is_read ON guardian_events(is_read);
CREATE INDEX idx_guardian_date ON guardian_events(event_date);
CREATE INDEX idx_backup_metadata_tenant_branch ON backup_metadata(tenant_id, branch_id);
CREATE INDEX idx_backup_metadata_created_at ON backup_metadata(created_at DESC);
CREATE INDEX idx_backup_metadata_expires_at ON backup_metadata(expires_at);

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- RESUMEN: 16 TABLAS
-- ═══════════════════════════════════════════════════════════════════════════
-- 1. subscriptions - Planes (Basic, Pro, Enterprise)
-- 2. tenants - Negocios con subscription
-- 3. branches - Sucursales con timezone
-- 4. employees - Empleados con password y main_branch_id
-- 5. employee_branches - Permisos por sucursal
-- 6. devices - Dispositivos móviles vinculados
-- 7. sessions - Sesiones JWT
-- 8. shifts - Turnos/cortes de caja
-- 9. sales - Ventas
-- 10. expense_categories - Categorías de gastos
-- 11. expenses - Gastos
-- 12. suppliers - Proveedores
-- 13. purchases - Compras
-- 14. cash_cuts - Cortes de caja
-- 15. guardian_events - Eventos báscula/Guardian
-- 16. backup_metadata - Metadata de backups en Dropbox
-- ═══════════════════════════════════════════════════════════════════════════
