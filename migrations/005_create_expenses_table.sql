-- ═══════════════════════════════════════════════════════════════════════════
-- MIGRACIÓN 005: Crear tabla EXPENSES (Gastos)
-- ═══════════════════════════════════════════════════════════════════════════
-- Fecha: 2025-10-14
-- Descripción: Tabla de gastos para monitoreo desde app móvil
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- Eliminar tabla si existe (para desarrollo - comentar en producción)
-- DROP TABLE IF EXISTS expenses CASCADE;

-- Crear tabla expenses
CREATE TABLE IF NOT EXISTS expenses (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL,
  branch_id INTEGER NOT NULL,
  shift_id INTEGER NOT NULL,
  business_id INTEGER NOT NULL,

  -- Información del gasto
  description VARCHAR(500) NOT NULL,
  total DECIMAL(10, 2) NOT NULL,
  quantity DECIMAL(10, 2),

  -- Categorización
  payment_type_id INTEGER,
  category_id INTEGER NOT NULL,

  -- Detalles adicionales
  note TEXT,
  expense_date TIMESTAMP NOT NULL,

  -- Estado y responsables
  status VARCHAR(50) NOT NULL DEFAULT 'completed',
  employee_id INTEGER NOT NULL,
  consumer_employee_id INTEGER,

  -- Auditoría
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  -- Sincronización
  remote_id INTEGER,
  synced BOOLEAN DEFAULT FALSE,
  synced_at TIMESTAMP
);

-- Índices para consultas rápidas
CREATE INDEX IF NOT EXISTS idx_expenses_tenant_branch ON expenses(tenant_id, branch_id);
CREATE INDEX IF NOT EXISTS idx_expenses_shift_id ON expenses(shift_id);
CREATE INDEX IF NOT EXISTS idx_expenses_employee_id ON expenses(employee_id);
CREATE INDEX IF NOT EXISTS idx_expenses_category_id ON expenses(category_id);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(expense_date);
CREATE INDEX IF NOT EXISTS idx_expenses_status ON expenses(status);
CREATE INDEX IF NOT EXISTS idx_expenses_consumer ON expenses(consumer_employee_id);
CREATE INDEX IF NOT EXISTS idx_expenses_payment_type ON expenses(payment_type_id);

-- Índice compuesto para consultas de dashboard
CREATE INDEX IF NOT EXISTS idx_expenses_tenant_branch_date
ON expenses(tenant_id, branch_id, expense_date);

-- Índice compuesto para consultas por turno
CREATE INDEX IF NOT EXISTS idx_expenses_shift_date
ON expenses(shift_id, expense_date);

-- Foreign keys
ALTER TABLE expenses
ADD CONSTRAINT fk_expenses_shift
FOREIGN KEY (shift_id)
REFERENCES shifts(id)
ON DELETE CASCADE;

-- Trigger para actualizar updated_at
CREATE OR REPLACE FUNCTION update_expenses_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_expenses_updated_at ON expenses;

CREATE TRIGGER trigger_update_expenses_updated_at
BEFORE UPDATE ON expenses
FOR EACH ROW
EXECUTE FUNCTION update_expenses_updated_at();

-- Vista completa para la app móvil
CREATE OR REPLACE VIEW v_expenses_complete AS
SELECT
  e.id,
  e.tenant_id,
  e.branch_id,
  b.name as branch_name,
  b.branch_code,
  e.shift_id,
  e.business_id,
  e.description,
  e.total,
  e.quantity,
  e.payment_type_id,
  e.category_id,
  ec.name as category_name,
  e.note,
  e.expense_date,
  e.status,
  e.employee_id,
  emp.full_name as employee_name,
  emp.username as employee_username,
  e.consumer_employee_id,
  consumer.full_name as consumer_name,
  e.created_at,
  e.updated_at,
  e.synced,
  e.synced_at
FROM expenses e
LEFT JOIN branches b ON e.branch_id = b.id
LEFT JOIN employees emp ON e.employee_id = emp.id
LEFT JOIN employees consumer ON e.consumer_employee_id = consumer.id
LEFT JOIN expense_categories ec ON e.category_id = ec.id;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- NOTAS:
-- - payment_type_id: Referencia a tipos de pago (efectivo, tarjeta, etc)
-- - category_id: Categoría del gasto (papelería, limpieza, etc)
-- - employee_id: Empleado que registró el gasto
-- - consumer_employee_id: Empleado que consumió/utilizó (si aplica)
-- - status: Estado del gasto ('completed', 'pending', 'cancelled')
-- ═══════════════════════════════════════════════════════════════════════════
