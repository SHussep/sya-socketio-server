-- ═══════════════════════════════════════════════════════════════════════════
-- MIGRACIÓN 001: Esquema MÍNIMO para App Móvil (SOLO CONSULTA)
-- ═══════════════════════════════════════════════════════════════════════════
-- App móvil SOLO consulta datos en tiempo real desde Desktop
-- Futuro: Empleados podrán loguearse y registrar gastos/devoluciones
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. TENANTS (Negocios)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE tenants (
  id SERIAL PRIMARY KEY,
  tenant_code VARCHAR NOT NULL UNIQUE,
  business_name VARCHAR NOT NULL,
  owner_email VARCHAR,
  phone_number VARCHAR,
  rfc VARCHAR,
  created_at BIGINT
);

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. BRANCHES (Sucursales)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE branches (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id),
  branch_code VARCHAR NOT NULL,
  branch_name VARCHAR NOT NULL,
  address VARCHAR,
  phone_number VARCHAR,
  timezone VARCHAR,
  created_at BIGINT
);

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. EMPLOYEES (Empleados - para login futuro)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE employees (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id),
  username VARCHAR NOT NULL,
  full_name VARCHAR NOT NULL,
  email VARCHAR NOT NULL,
  password_hash VARCHAR,
  role VARCHAR,
  is_active INTEGER DEFAULT 1,
  created_at BIGINT,
  UNIQUE(tenant_id, username)
);

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. SHIFTS (Turnos / Cortes de Caja)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE shifts (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id),
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  employee_id INTEGER REFERENCES employees(id),
  start_time BIGINT NOT NULL,
  end_time BIGINT,
  initial_amount FLOAT DEFAULT 0,
  final_amount FLOAT DEFAULT 0,
  total_sales FLOAT DEFAULT 0,
  total_expenses FLOAT DEFAULT 0,
  is_closed INTEGER DEFAULT 0,
  synced_at BIGINT
);

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. SALES (Ventas)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE sales (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id),
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  shift_id INTEGER NOT NULL REFERENCES shifts(id),
  employee_id INTEGER REFERENCES employees(id),
  ticket_number INTEGER NOT NULL,
  sale_date BIGINT NOT NULL,
  sale_type VARCHAR,
  payment_method VARCHAR,
  subtotal FLOAT DEFAULT 0,
  total FLOAT NOT NULL,
  synced_at BIGINT
);

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. EXPENSES (Gastos)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE expenses (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id),
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  shift_id INTEGER NOT NULL REFERENCES shifts(id),
  employee_id INTEGER REFERENCES employees(id),
  description VARCHAR NOT NULL,
  category VARCHAR,
  total FLOAT NOT NULL,
  expense_date BIGINT NOT NULL,
  synced_at BIGINT
);

-- ═══════════════════════════════════════════════════════════════════════════
-- 7. PURCHASES (Compras)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE purchases (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id),
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  shift_id INTEGER NOT NULL REFERENCES shifts(id),
  supplier_name VARCHAR,
  total FLOAT NOT NULL,
  purchase_date BIGINT NOT NULL,
  status VARCHAR,
  synced_at BIGINT
);

-- ═══════════════════════════════════════════════════════════════════════════
-- 8. GUARDIAN_EVENTS (Eventos de Báscula/Monitoreo)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE guardian_events (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id),
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  shift_id INTEGER REFERENCES shifts(id),
  employee_id INTEGER REFERENCES employees(id),
  event_type VARCHAR NOT NULL,
  severity VARCHAR NOT NULL,
  description TEXT NOT NULL,
  event_date BIGINT NOT NULL,
  is_read INTEGER DEFAULT 0,
  synced_at BIGINT
);

-- ═══════════════════════════════════════════════════════════════════════════
-- ÍNDICES (solo los necesarios para consultas rápidas)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE INDEX idx_branches_tenant ON branches(tenant_id);
CREATE INDEX idx_employees_tenant ON employees(tenant_id);
CREATE INDEX idx_shifts_tenant_branch ON shifts(tenant_id, branch_id);
CREATE INDEX idx_shifts_employee ON shifts(employee_id);
CREATE INDEX idx_sales_tenant_branch ON sales(tenant_id, branch_id);
CREATE INDEX idx_sales_shift ON sales(shift_id);
CREATE INDEX idx_sales_date ON sales(sale_date);
CREATE INDEX idx_expenses_tenant_branch ON expenses(tenant_id, branch_id);
CREATE INDEX idx_expenses_shift ON expenses(shift_id);
CREATE INDEX idx_expenses_date ON expenses(expense_date);
CREATE INDEX idx_purchases_tenant_branch ON purchases(tenant_id, branch_id);
CREATE INDEX idx_purchases_date ON purchases(purchase_date);
CREATE INDEX idx_guardian_tenant_branch ON guardian_events(tenant_id, branch_id);
CREATE INDEX idx_guardian_date ON guardian_events(event_date);
CREATE INDEX idx_guardian_is_read ON guardian_events(is_read);

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- RESUMEN: 8 TABLAS MÍNIMAS
-- ═══════════════════════════════════════════════════════════════════════════
-- 1. tenants - Negocios (tenant_code, business_name, rfc, phone)
-- 2. branches - Sucursales (branch_name, address, timezone)
-- 3. employees - Empleados (username, full_name, role) [login futuro]
-- 4. shifts - Turnos/Cortes (start_time, end_time, total_sales, total_expenses)
-- 5. sales - Ventas (ticket_number, total, sale_date, payment_method)
-- 6. expenses - Gastos (description, total, expense_date)
-- 7. purchases - Compras (supplier_name, total, purchase_date)
-- 8. guardian_events - Eventos báscula (event_type, severity, description)
-- ═══════════════════════════════════════════════════════════════════════════
