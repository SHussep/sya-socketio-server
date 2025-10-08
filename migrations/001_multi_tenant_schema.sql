-- ============================================================================
-- MIGRACIÓN MULTI-TENANT - SYA TORTILLERÍAS
-- Versión: 1.0.0
-- Fecha: 2025-10-07
-- Descripción: Schema completo para arquitectura multi-tenant
-- ============================================================================

-- ============================================================================
-- IMPORTANTE: Esta migración borrará todos los datos existentes
-- ============================================================================

BEGIN;

-- Borrar tablas existentes en orden correcto (respetando foreign keys)
DROP TABLE IF EXISTS guardian_events CASCADE;
DROP TABLE IF EXISTS cash_cuts CASCADE;
DROP TABLE IF EXISTS shifts CASCADE;
DROP TABLE IF EXISTS purchase_items CASCADE;
DROP TABLE IF EXISTS purchases CASCADE;
DROP TABLE IF EXISTS sale_items CASCADE;
DROP TABLE IF EXISTS sales CASCADE;
DROP TABLE IF EXISTS expenses CASCADE;
DROP TABLE IF EXISTS expense_categories CASCADE;
DROP TABLE IF EXISTS delivery_person_branches CASCADE;
DROP TABLE IF EXISTS delivery_persons CASCADE;
DROP TABLE IF EXISTS suppliers CASCADE;
DROP TABLE IF EXISTS customers CASCADE;
DROP TABLE IF EXISTS branch_inventory CASCADE;
DROP TABLE IF EXISTS products CASCADE;
DROP TABLE IF EXISTS employee_branches CASCADE;
DROP TABLE IF EXISTS employees CASCADE;
DROP TABLE IF EXISTS branches CASCADE;
DROP TABLE IF EXISTS tenants CASCADE;
DROP TABLE IF EXISTS subscriptions CASCADE;

-- ============================================================================
-- TABLAS CORE
-- ============================================================================

-- Planes de suscripción
CREATE TABLE subscriptions (
  id SERIAL PRIMARY KEY,
  name VARCHAR(50) NOT NULL UNIQUE,
  max_branches INTEGER NOT NULL, -- -1 = ilimitado
  max_devices INTEGER NOT NULL,
  max_employees INTEGER NOT NULL,
  price_monthly DECIMAL(10,2) NOT NULL,
  features JSONB,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Seed data de planes
INSERT INTO subscriptions (name, max_branches, max_devices, max_employees, price_monthly, features) VALUES
('Free', 1, 3, 5, 0.00, '{"sync_interval": 3600, "support": "email", "storage_gb": 1}'),
('Basic', 3, 10, 15, 299.00, '{"sync_interval": 300, "support": "priority", "reports": "basic", "storage_gb": 10}'),
('Pro', 10, 30, 50, 799.00, '{"sync_interval": 60, "support": "24/7", "reports": "advanced", "api": true, "storage_gb": 100}'),
('Enterprise', -1, -1, -1, 1999.00, '{"sync_interval": 10, "support": "dedicated", "reports": "custom", "api": true, "white_label": true, "storage_gb": 500}');

-- Tenants (Negocios)
CREATE TABLE tenants (
  id SERIAL PRIMARY KEY,
  business_name VARCHAR(200) NOT NULL,
  rfc VARCHAR(13),
  owner_email VARCHAR(255) NOT NULL UNIQUE,
  phone VARCHAR(20),
  address TEXT,
  subscription_id INTEGER NOT NULL DEFAULT 1 REFERENCES subscriptions(id),
  subscription_expires_at TIMESTAMP,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_tenants_owner_email ON tenants(owner_email);
CREATE INDEX idx_tenants_subscription ON tenants(subscription_id);

-- Sucursales
CREATE TABLE branches (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_code VARCHAR(20) NOT NULL,
  name VARCHAR(200) NOT NULL,
  address TEXT,
  phone_number VARCHAR(20),
  latitude DECIMAL(10, 8),
  longitude DECIMAL(11, 8),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tenant_id, branch_code)
);

CREATE INDEX idx_branches_tenant ON branches(tenant_id);

-- Empleados
CREATE TABLE employees (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  main_branch_id INTEGER REFERENCES branches(id),
  email VARCHAR(255) NOT NULL,
  username VARCHAR(100) NOT NULL,
  password VARCHAR(255) NOT NULL,
  full_name VARCHAR(200) NOT NULL,
  role VARCHAR(50) NOT NULL, -- owner, manager, cashier, delivery
  phone VARCHAR(20),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tenant_id, email),
  UNIQUE(tenant_id, username)
);

CREATE INDEX idx_employees_tenant ON employees(tenant_id);
CREATE INDEX idx_employees_email ON employees(email);
CREATE INDEX idx_employees_username ON employees(username);

-- Junction table: Empleados ↔️ Sucursales (N:M)
CREATE TABLE employee_branches (
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  can_login BOOLEAN DEFAULT true,
  can_sell BOOLEAN DEFAULT true,
  can_manage_inventory BOOLEAN DEFAULT false,
  can_close_shift BOOLEAN DEFAULT false,
  assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (employee_id, branch_id)
);

CREATE INDEX idx_employee_branches_employee ON employee_branches(employee_id);
CREATE INDEX idx_employee_branches_branch ON employee_branches(branch_id);

-- ============================================================================
-- PRODUCTOS E INVENTARIO
-- ============================================================================

-- Productos (catálogo por tenant)
CREATE TABLE products (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sku VARCHAR(50),
  name VARCHAR(200) NOT NULL,
  description TEXT,
  unit_type VARCHAR(50), -- kg, pcs, liters, box
  price DECIMAL(10,2) NOT NULL,
  cost DECIMAL(10,2),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tenant_id, sku)
);

CREATE INDEX idx_products_tenant ON products(tenant_id);
CREATE INDEX idx_products_sku ON products(tenant_id, sku);

-- Inventario por sucursal
CREATE TABLE branch_inventory (
  id SERIAL PRIMARY KEY,
  branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  quantity DECIMAL(10,3) DEFAULT 0,
  min_quantity DECIMAL(10,3) DEFAULT 0,
  max_quantity DECIMAL(10,3),
  last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(branch_id, product_id)
);

CREATE INDEX idx_branch_inventory_branch ON branch_inventory(branch_id);
CREATE INDEX idx_branch_inventory_product ON branch_inventory(product_id);

-- ============================================================================
-- CLIENTES, PROVEEDORES, REPARTIDORES
-- ============================================================================

-- Clientes
CREATE TABLE customers (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_code VARCHAR(50),
  name VARCHAR(200) NOT NULL,
  phone VARCHAR(20),
  email VARCHAR(255),
  address TEXT,
  loyalty_points INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tenant_id, customer_code)
);

CREATE INDEX idx_customers_tenant ON customers(tenant_id);
CREATE INDEX idx_customers_code ON customers(tenant_id, customer_code);

-- Proveedores
CREATE TABLE suppliers (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  supplier_code VARCHAR(50),
  name VARCHAR(200) NOT NULL,
  contact_name VARCHAR(200),
  phone VARCHAR(20),
  email VARCHAR(255),
  address TEXT,
  rfc VARCHAR(13),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tenant_id, supplier_code)
);

CREATE INDEX idx_suppliers_tenant ON suppliers(tenant_id);
CREATE INDEX idx_suppliers_code ON suppliers(tenant_id, supplier_code);

-- Repartidores
CREATE TABLE delivery_persons (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name VARCHAR(200) NOT NULL,
  phone VARCHAR(20),
  vehicle_type VARCHAR(50), -- bike, motorcycle, car, truck
  license_plate VARCHAR(20),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_delivery_persons_tenant ON delivery_persons(tenant_id);

-- Junction table: Repartidores ↔️ Sucursales (N:M)
CREATE TABLE delivery_person_branches (
  delivery_person_id INTEGER NOT NULL REFERENCES delivery_persons(id) ON DELETE CASCADE,
  branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (delivery_person_id, branch_id)
);

-- ============================================================================
-- TRANSACCIONES: VENTAS
-- ============================================================================

-- Ventas
CREATE TABLE sales (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  employee_id INTEGER REFERENCES employees(id),
  customer_id INTEGER REFERENCES customers(id),
  ticket_number VARCHAR(50) NOT NULL,
  total_amount DECIMAL(10,2) NOT NULL,
  payment_method VARCHAR(50),
  sale_type VARCHAR(50) DEFAULT 'counter', -- counter, delivery, pickup
  delivery_person_id INTEGER REFERENCES delivery_persons(id),
  notes TEXT,
  sale_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tenant_id, ticket_number)
);

CREATE INDEX idx_sales_tenant ON sales(tenant_id);
CREATE INDEX idx_sales_branch ON sales(branch_id);
CREATE INDEX idx_sales_employee ON sales(employee_id);
CREATE INDEX idx_sales_date ON sales(sale_date);
CREATE INDEX idx_sales_ticket ON sales(tenant_id, ticket_number);

-- Detalles de venta
CREATE TABLE sale_items (
  id SERIAL PRIMARY KEY,
  sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  quantity DECIMAL(10,3) NOT NULL,
  unit_price DECIMAL(10,2) NOT NULL,
  subtotal DECIMAL(10,2) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_sale_items_sale ON sale_items(sale_id);
CREATE INDEX idx_sale_items_product ON sale_items(product_id);

-- ============================================================================
-- TRANSACCIONES: GASTOS
-- ============================================================================

-- Categorías de gastos
CREATE TABLE expense_categories (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tenant_id, name)
);

CREATE INDEX idx_expense_categories_tenant ON expense_categories(tenant_id);

-- Gastos
CREATE TABLE expenses (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  employee_id INTEGER REFERENCES employees(id),
  category_id INTEGER REFERENCES expense_categories(id),
  description TEXT NOT NULL,
  amount DECIMAL(10,2) NOT NULL,
  expense_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_expenses_tenant ON expenses(tenant_id);
CREATE INDEX idx_expenses_branch ON expenses(branch_id);
CREATE INDEX idx_expenses_employee ON expenses(employee_id);
CREATE INDEX idx_expenses_date ON expenses(expense_date);

-- ============================================================================
-- TRANSACCIONES: COMPRAS
-- ============================================================================

-- Compras a proveedores
CREATE TABLE purchases (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  employee_id INTEGER REFERENCES employees(id),
  purchase_number VARCHAR(50) NOT NULL,
  total_amount DECIMAL(10,2) NOT NULL,
  payment_status VARCHAR(50) DEFAULT 'pending', -- pending, paid, partial
  notes TEXT,
  purchase_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tenant_id, purchase_number)
);

CREATE INDEX idx_purchases_tenant ON purchases(tenant_id);
CREATE INDEX idx_purchases_branch ON purchases(branch_id);
CREATE INDEX idx_purchases_supplier ON purchases(supplier_id);
CREATE INDEX idx_purchases_date ON purchases(purchase_date);

-- Detalles de compra
CREATE TABLE purchase_items (
  id SERIAL PRIMARY KEY,
  purchase_id INTEGER NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  quantity DECIMAL(10,3) NOT NULL,
  unit_cost DECIMAL(10,2) NOT NULL,
  subtotal DECIMAL(10,2) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_purchase_items_purchase ON purchase_items(purchase_id);
CREATE INDEX idx_purchase_items_product ON purchase_items(product_id);

-- ============================================================================
-- OPERACIONES: CORTES Y TURNOS
-- ============================================================================

-- Cortes de caja
CREATE TABLE cash_cuts (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  cut_number VARCHAR(50) NOT NULL,
  total_sales DECIMAL(10,2) NOT NULL,
  total_expenses DECIMAL(10,2) NOT NULL,
  cash_in_drawer DECIMAL(10,2) NOT NULL,
  expected_cash DECIMAL(10,2) NOT NULL,
  difference DECIMAL(10,2) NOT NULL,
  notes TEXT,
  cut_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tenant_id, cut_number)
);

CREATE INDEX idx_cash_cuts_tenant ON cash_cuts(tenant_id);
CREATE INDEX idx_cash_cuts_branch ON cash_cuts(branch_id);
CREATE INDEX idx_cash_cuts_employee ON cash_cuts(employee_id);
CREATE INDEX idx_cash_cuts_date ON cash_cuts(cut_date);

-- Turnos de empleados
CREATE TABLE shifts (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  start_time TIMESTAMP NOT NULL,
  end_time TIMESTAMP,
  initial_cash DECIMAL(10,2),
  final_cash DECIMAL(10,2),
  is_active BOOLEAN DEFAULT true,
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_shifts_tenant ON shifts(tenant_id);
CREATE INDEX idx_shifts_branch ON shifts(branch_id);
CREATE INDEX idx_shifts_employee ON shifts(employee_id);
CREATE INDEX idx_shifts_active ON shifts(tenant_id, branch_id, is_active);

-- ============================================================================
-- SISTEMA: EVENTOS Y LOGS
-- ============================================================================

-- Eventos del sistema Guardian
CREATE TABLE guardian_events (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id INTEGER REFERENCES branches(id),
  employee_id INTEGER REFERENCES employees(id),
  event_type VARCHAR(100) NOT NULL, -- scale_error, low_inventory, system_error, etc
  severity VARCHAR(20) NOT NULL, -- info, warning, error, critical
  title VARCHAR(200) NOT NULL,
  description TEXT,
  metadata JSONB,
  resolved BOOLEAN DEFAULT false,
  resolved_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_guardian_events_tenant ON guardian_events(tenant_id);
CREATE INDEX idx_guardian_events_branch ON guardian_events(branch_id);
CREATE INDEX idx_guardian_events_date ON guardian_events(created_at);
CREATE INDEX idx_guardian_events_severity ON guardian_events(severity);
CREATE INDEX idx_guardian_events_resolved ON guardian_events(resolved);

-- ============================================================================
-- TRIGGERS: Updated_at automático
-- ============================================================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_tenants_updated_at BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_branches_updated_at BEFORE UPDATE ON branches
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_employees_updated_at BEFORE UPDATE ON employees
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_products_updated_at BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_customers_updated_at BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_suppliers_updated_at BEFORE UPDATE ON suppliers
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMIT;

-- ============================================================================
-- VERIFICACIÓN
-- ============================================================================

-- Contar tablas creadas
SELECT
  schemaname,
  COUNT(*) as table_count
FROM pg_tables
WHERE schemaname = 'public'
GROUP BY schemaname;

-- Listar todas las tablas
SELECT tablename
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY tablename;

-- Verificar planes de suscripción
SELECT * FROM subscriptions ORDER BY id;

-- Fin de la migración
