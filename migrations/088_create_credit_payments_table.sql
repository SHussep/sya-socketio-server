-- =====================================================
-- Migration: 088_create_credit_payments_table.sql
-- Descripción: Tabla para pagos de crédito de clientes
-- =====================================================

-- PROBLEMA: Los pagos de crédito solo existen en Desktop (CashTransaction tipo 6 y 7)
-- SOLUCIÓN: Tabla dedicada para sincronizar pagos y mantener historial de crédito

CREATE TABLE IF NOT EXISTS credit_payments (
  id SERIAL PRIMARY KEY,

  -- Scope
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,

  -- Referencias
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  shift_id INTEGER REFERENCES shifts(id) ON DELETE SET NULL,
  employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,

  -- Datos del pago
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  payment_method VARCHAR(20) NOT NULL CHECK (payment_method IN ('cash', 'card')),
  payment_date TIMESTAMPTZ NOT NULL,
  notes TEXT,

  -- Offline-first (idempotencia)
  global_id VARCHAR(255) UNIQUE NOT NULL,
  terminal_id VARCHAR(100),
  local_op_seq INTEGER,
  device_event_raw BIGINT,
  created_local_utc TEXT,

  -- Sync
  synced BOOLEAN DEFAULT TRUE,
  synced_at TIMESTAMPTZ DEFAULT NOW(),

  -- Auditoría
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ========== ÍNDICES ==========

CREATE INDEX IF NOT EXISTS idx_credit_payments_tenant_branch
  ON credit_payments(tenant_id, branch_id);

CREATE INDEX IF NOT EXISTS idx_credit_payments_customer
  ON credit_payments(customer_id, payment_date DESC);

CREATE INDEX IF NOT EXISTS idx_credit_payments_shift
  ON credit_payments(shift_id)
  WHERE shift_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_credit_payments_employee
  ON credit_payments(employee_id, payment_date DESC)
  WHERE employee_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_credit_payments_global_id
  ON credit_payments(global_id);

CREATE INDEX IF NOT EXISTS idx_credit_payments_terminal_seq
  ON credit_payments(terminal_id, local_op_seq)
  WHERE terminal_id IS NOT NULL AND local_op_seq IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_credit_payments_method
  ON credit_payments(tenant_id, payment_method, payment_date DESC);

-- ========== TRIGGER PARA UPDATED_AT ==========
CREATE TRIGGER trg_credit_payments_updated_at
  BEFORE UPDATE ON credit_payments
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ========== TRIGGER PARA ACTUALIZAR SALDO DEL CLIENTE ==========
-- Cuando se registra un pago, se descuenta automáticamente del saldo_deudor del cliente
CREATE OR REPLACE FUNCTION update_customer_balance_on_payment()
RETURNS TRIGGER AS $$
BEGIN
  -- Descontar el pago del saldo deudor del cliente
  UPDATE customers
  SET saldo_deudor = GREATEST(0, saldo_deudor - NEW.amount),
      updated_at = NOW()
  WHERE id = NEW.customer_id;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_update_customer_balance_on_payment
  AFTER INSERT ON credit_payments
  FOR EACH ROW
  EXECUTE FUNCTION update_customer_balance_on_payment();

-- ========== COMENTARIOS ==========
COMMENT ON TABLE credit_payments IS 'Pagos de crédito de clientes - sincronizado desde Desktop CashTransaction tipo 6 y 7';
COMMENT ON COLUMN credit_payments.customer_id IS 'Cliente que realizó el pago';
COMMENT ON COLUMN credit_payments.amount IS 'Monto del pago (siempre positivo)';
COMMENT ON COLUMN credit_payments.payment_method IS 'Método de pago: cash o card';
COMMENT ON COLUMN credit_payments.payment_date IS 'Fecha y hora del pago';
COMMENT ON COLUMN credit_payments.global_id IS 'UUID para idempotencia - evita duplicados en sincronización';
COMMENT ON COLUMN credit_payments.notes IS 'Notas adicionales sobre el pago';

-- ========== VISTA PARA APP MÓVIL ==========
-- Vista simplificada para consultas desde app móvil
CREATE OR REPLACE VIEW v_credit_payments_summary AS
SELECT
  cp.id,
  cp.tenant_id,
  cp.branch_id,
  cp.customer_id,
  c.nombre as customer_name,
  c.telefono as customer_phone,
  cp.amount,
  cp.payment_method,
  cp.payment_date,
  cp.notes,
  CONCAT(e.first_name, ' ', e.last_name) as employee_name,
  b.name as branch_name
FROM credit_payments cp
LEFT JOIN customers c ON cp.customer_id = c.id
LEFT JOIN employees e ON cp.employee_id = e.id
LEFT JOIN branches b ON cp.branch_id = b.id
ORDER BY cp.payment_date DESC;

COMMENT ON VIEW v_credit_payments_summary IS 'Vista simplificada de pagos de crédito con joins para app móvil';
