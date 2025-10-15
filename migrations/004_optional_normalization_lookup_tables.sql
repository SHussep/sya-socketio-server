-- ============================================================================
-- MIGRACIÓN OPCIONAL: NORMALIZACIÓN CON TABLAS LOOKUP
-- ============================================================================
-- ADVERTENCIA: Esta migración es OPCIONAL
-- Solo aplícala si necesitas:
-- 1. Agregar metadata a los tipos (colores, iconos, descripciones)
-- 2. Traducciones en múltiples idiomas
-- 3. Control estricto de valores permitidos
-- ============================================================================

BEGIN;

-- ============================================================================
-- TABLAS LOOKUP NORMALIZADAS
-- ============================================================================

-- Tipos de venta (sale_types)
CREATE TABLE IF NOT EXISTS sale_types (
  id SERIAL PRIMARY KEY,
  code VARCHAR(20) NOT NULL UNIQUE,  -- 'counter', 'delivery', 'pickup'
  name VARCHAR(100) NOT NULL,        -- 'Mostrador', 'Repartidor', 'Para llevar'
  description TEXT,
  icon VARCHAR(50),                  -- 'store', 'motorcycle', 'takeout'
  color VARCHAR(7),                  -- '#4CAF50', '#2196F3', '#FF9800'
  display_order INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Métodos de pago (payment_methods)
CREATE TABLE IF NOT EXISTS payment_methods (
  id SERIAL PRIMARY KEY,
  code VARCHAR(20) NOT NULL UNIQUE,  -- 'cash', 'card', 'transfer'
  name VARCHAR(100) NOT NULL,        -- 'Efectivo', 'Tarjeta', 'Transferencia'
  description TEXT,
  icon VARCHAR(50),                  -- 'money', 'credit_card', 'bank'
  color VARCHAR(7),
  requires_reference BOOLEAN DEFAULT false,
  display_order INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Roles de empleados (employee_roles)
CREATE TABLE IF NOT EXISTS employee_roles (
  id SERIAL PRIMARY KEY,
  code VARCHAR(20) NOT NULL UNIQUE,  -- 'owner', 'admin', 'supervisor', 'employee'
  name VARCHAR(100) NOT NULL,        -- 'Propietario', 'Administrador', 'Supervisor', 'Empleado'
  description TEXT,
  permissions JSONB,                 -- { "can_delete_sales": true, "can_view_reports": true }
  level INTEGER DEFAULT 0,           -- Para jerarquía
  display_order INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Estados de pago (payment_statuses)
CREATE TABLE IF NOT EXISTS payment_statuses (
  id SERIAL PRIMARY KEY,
  code VARCHAR(20) NOT NULL UNIQUE,  -- 'pending', 'paid', 'partial', 'overdue'
  name VARCHAR(100) NOT NULL,        -- 'Pendiente', 'Pagado', 'Parcial', 'Vencido'
  description TEXT,
  icon VARCHAR(50),
  color VARCHAR(7),
  is_final BOOLEAN DEFAULT false,    -- true para 'paid'
  display_order INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- SEED DATA (valores por defecto)
-- ============================================================================

-- Sale Types
INSERT INTO sale_types (code, name, description, icon, color, display_order) VALUES
('counter', 'Mostrador', 'Venta en mostrador directa al cliente', 'store', '#4CAF50', 1),
('delivery', 'Repartidor', 'Venta entregada a domicilio', 'motorcycle', '#2196F3', 2),
('pickup', 'Para llevar', 'Cliente pide y recoge más tarde', 'takeout', '#FF9800', 3)
ON CONFLICT (code) DO NOTHING;

-- Payment Methods
INSERT INTO payment_methods (code, name, description, icon, color, requires_reference, display_order) VALUES
('cash', 'Efectivo', 'Pago en efectivo', 'money', '#4CAF50', false, 1),
('card', 'Tarjeta', 'Pago con tarjeta de crédito/débito', 'credit_card', '#2196F3', true, 2),
('transfer', 'Transferencia', 'Transferencia bancaria', 'bank', '#9C27B0', true, 3),
('check', 'Cheque', 'Pago con cheque', 'receipt', '#FF9800', true, 4)
ON CONFLICT (code) DO NOTHING;

-- Employee Roles
INSERT INTO employee_roles (code, name, description, level, display_order) VALUES
('owner', 'Propietario', 'Dueño del negocio con acceso completo', 100, 1),
('admin', 'Administrador', 'Administrador con permisos casi completos', 80, 2),
('supervisor', 'Supervisor', 'Supervisor de sucursal', 60, 3),
('employee', 'Empleado', 'Empleado de mostrador o repartidor', 20, 4)
ON CONFLICT (code) DO NOTHING;

-- Payment Statuses
INSERT INTO payment_statuses (code, name, description, icon, color, is_final, display_order) VALUES
('pending', 'Pendiente', 'Pago pendiente', 'schedule', '#FFC107', false, 1),
('partial', 'Parcial', 'Pago parcial realizado', 'trending_up', '#FF9800', false, 2),
('paid', 'Pagado', 'Pago completado', 'check_circle', '#4CAF50', true, 3),
('overdue', 'Vencido', 'Pago vencido', 'error', '#F44336', false, 4)
ON CONFLICT (code) DO NOTHING;

-- ============================================================================
-- AGREGAR NUEVAS COLUMNAS CON IDs (Mantener las antiguas por compatibilidad)
-- ============================================================================

-- Agregar sale_type_id a sales (mantener sale_type por compatibilidad)
ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS sale_type_id INTEGER REFERENCES sale_types(id);

-- Agregar payment_method_id a sales (mantener payment_method por compatibilidad)
ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS payment_method_id INTEGER REFERENCES payment_methods(id);

-- Agregar role_id a employees (mantener role por compatibilidad)
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS role_id INTEGER REFERENCES employee_roles(id);

-- Agregar payment_status_id a purchases (mantener payment_status por compatibilidad)
ALTER TABLE purchases
  ADD COLUMN IF NOT EXISTS payment_status_id INTEGER REFERENCES payment_statuses(id);

-- ============================================================================
-- MIGRAR DATOS EXISTENTES (String → ID)
-- ============================================================================

-- Migrar sale_type
UPDATE sales s
SET sale_type_id = st.id
FROM sale_types st
WHERE LOWER(s.sale_type) = LOWER(st.code);

-- Migrar payment_method
UPDATE sales s
SET payment_method_id = pm.id
FROM payment_methods pm
WHERE LOWER(s.payment_method) = LOWER(pm.code);

-- Migrar role
UPDATE employees e
SET role_id = er.id
FROM employee_roles er
WHERE LOWER(e.role) = LOWER(er.code);

-- Migrar payment_status
UPDATE purchases p
SET payment_status_id = ps.id
FROM payment_statuses ps
WHERE LOWER(p.payment_status) = LOWER(ps.code);

-- ============================================================================
-- CREAR ÍNDICES
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_sales_sale_type_id ON sales(sale_type_id);
CREATE INDEX IF NOT EXISTS idx_sales_payment_method_id ON sales(payment_method_id);
CREATE INDEX IF NOT EXISTS idx_employees_role_id ON employees(role_id);
CREATE INDEX IF NOT EXISTS idx_purchases_payment_status_id ON purchases(payment_status_id);

COMMIT;

-- ============================================================================
-- QUERIES DE EJEMPLO CON NORMALIZACIÓN
-- ============================================================================

-- Obtener ventas con tipo de venta (JOIN)
-- SELECT s.*, st.name as sale_type_name, st.icon, st.color
-- FROM sales s
-- LEFT JOIN sale_types st ON s.sale_type_id = st.id
-- WHERE s.tenant_id = 1
-- ORDER BY s.sale_date DESC
-- LIMIT 10;

-- Obtener ventas agrupadas por tipo
-- SELECT
--   st.name as sale_type,
--   COUNT(*) as total_sales,
--   SUM(s.total_amount) as total_amount
-- FROM sales s
-- LEFT JOIN sale_types st ON s.sale_type_id = st.id
-- WHERE s.tenant_id = 1
-- GROUP BY st.name;

-- ============================================================================
-- NOTAS IMPORTANTES
-- ============================================================================

-- 1. NO BORRES LAS COLUMNAS ANTIGUAS (sale_type, payment_method, role, payment_status)
--    Mantenlas por compatibilidad con código existente
--
-- 2. ESTRATEGIA GRADUAL:
--    a) Aplica esta migración
--    b) Actualiza el código para usar *_id en nuevos registros
--    c) Mantén compatibilidad leyendo ambas columnas
--    d) Después de 6 meses, borra las columnas antiguas
--
-- 3. VENTAJAS DE LA NORMALIZACIÓN:
--    - Agregar metadata (colores, iconos, descripciones)
--    - Traducciones (puedes crear sale_types_translations)
--    - Validación en BD (solo valores permitidos)
--    - Cambios centralizados
--
-- 4. DESVENTAJAS:
--    - Queries más complejos (necesitas JOINs)
--    - Código más verboso
--    - Migraciones más complicadas
--
-- 5. RECOMENDACIÓN:
--    Solo normaliza si necesitas las ventajas mencionadas.
--    Para un MVP, mantener strings es perfectamente válido.
