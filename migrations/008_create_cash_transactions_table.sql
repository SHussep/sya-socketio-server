-- ═══════════════════════════════════════════════════════════════════════════
-- MIGRACIÓN 008: Crear tabla CASH_TRANSACTIONS (Movimientos de Caja)
-- ═══════════════════════════════════════════════════════════════════════════
-- Fecha: 2025-10-14
-- Descripción: Tabla de movimientos de caja (depósitos/retiros) para app móvil
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- Crear tabla cash_transactions
CREATE TABLE IF NOT EXISTS cash_transactions (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL,
  branch_id INTEGER NOT NULL,
  shift_id INTEGER NOT NULL,
  employee_id INTEGER NOT NULL,

  -- Información de la transacción
  transaction_timestamp TIMESTAMP NOT NULL,
  transaction_type INTEGER NOT NULL,  -- 0=Sale, 1=Expense, 2=Deposit, 3=Withdrawal, 4=ClientPayment
  amount DECIMAL(10, 2) NOT NULL,
  description VARCHAR(500),

  -- IDs opcionales para navegar a la fuente original
  sale_id INTEGER,
  expense_id INTEGER,
  client_payment_id INTEGER,

  -- Detalles adicionales
  notes TEXT,

  -- Anulación
  is_voided BOOLEAN DEFAULT FALSE,
  voided_at TIMESTAMP,
  voided_by_employee_id INTEGER,
  void_reason TEXT,

  -- Auditoría
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  -- Sincronización
  remote_id INTEGER,
  synced BOOLEAN DEFAULT FALSE,
  synced_at TIMESTAMP
);

-- Índices para consultas rápidas
CREATE INDEX IF NOT EXISTS idx_cash_trans_tenant_branch ON cash_transactions(tenant_id, branch_id);
CREATE INDEX IF NOT EXISTS idx_cash_trans_shift_id ON cash_transactions(shift_id);
CREATE INDEX IF NOT EXISTS idx_cash_trans_employee_id ON cash_transactions(employee_id);
CREATE INDEX IF NOT EXISTS idx_cash_trans_type ON cash_transactions(transaction_type);
CREATE INDEX IF NOT EXISTS idx_cash_trans_timestamp ON cash_transactions(transaction_timestamp);
CREATE INDEX IF NOT EXISTS idx_cash_trans_is_voided ON cash_transactions(is_voided);
CREATE INDEX IF NOT EXISTS idx_cash_trans_sale_id ON cash_transactions(sale_id);
CREATE INDEX IF NOT EXISTS idx_cash_trans_expense_id ON cash_transactions(expense_id);
CREATE INDEX IF NOT EXISTS idx_cash_trans_payment_id ON cash_transactions(client_payment_id);

-- Índice compuesto para consultas de dashboard
CREATE INDEX IF NOT EXISTS idx_cash_trans_tenant_branch_date
ON cash_transactions(tenant_id, branch_id, transaction_timestamp);

-- Índice compuesto para consultas por turno
CREATE INDEX IF NOT EXISTS idx_cash_trans_shift_date
ON cash_transactions(shift_id, transaction_timestamp);

-- Foreign keys
ALTER TABLE cash_transactions
ADD CONSTRAINT fk_cash_trans_shift
FOREIGN KEY (shift_id)
REFERENCES shifts(id)
ON DELETE CASCADE;

-- Trigger para actualizar updated_at
CREATE OR REPLACE FUNCTION update_cash_trans_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_cash_trans_updated_at ON cash_transactions;

CREATE TRIGGER trigger_update_cash_trans_updated_at
BEFORE UPDATE ON cash_transactions
FOR EACH ROW
EXECUTE FUNCTION update_cash_trans_updated_at();

-- Vista completa para la app móvil
CREATE OR REPLACE VIEW v_cash_transactions_complete AS
SELECT
  ct.id,
  ct.tenant_id,
  ct.branch_id,
  b.name as branch_name,
  b.branch_code,
  ct.shift_id,
  ct.employee_id,
  e.full_name as employee_name,
  e.username as employee_username,
  ct.transaction_timestamp,
  ct.transaction_type,
  CASE ct.transaction_type
    WHEN 0 THEN 'Venta'
    WHEN 1 THEN 'Gasto'
    WHEN 2 THEN 'Depósito'
    WHEN 3 THEN 'Retiro'
    WHEN 4 THEN 'Pago de Cliente'
    ELSE 'Desconocido'
  END as transaction_type_name,
  ct.amount,
  ct.description,
  ct.sale_id,
  ct.expense_id,
  ct.client_payment_id,
  ct.notes,
  ct.is_voided,
  ct.voided_at,
  ct.voided_by_employee_id,
  voider.full_name as voided_by_name,
  ct.void_reason,
  CASE
    WHEN ct.is_voided THEN
      CASE
        WHEN ct.void_reason IS NOT NULL THEN ct.void_reason || ' • ' || COALESCE(voider.full_name, '')
        WHEN voider.full_name IS NOT NULL THEN 'Cancelada por ' || voider.full_name
        ELSE 'Cancelada'
      END
    ELSE NULL
  END as void_summary,
  ct.created_at,
  ct.updated_at,
  ct.synced,
  ct.synced_at
FROM cash_transactions ct
LEFT JOIN branches b ON ct.branch_id = b.id
LEFT JOIN employees e ON ct.employee_id = e.id
LEFT JOIN employees voider ON ct.voided_by_employee_id = voider.id;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- NOTAS:
-- - transaction_type: 0=Sale, 1=Expense, 2=Deposit, 3=Withdrawal, 4=ClientPayment
-- - amount: Monto (+ para ingresos, - para salidas)
-- - description: Descripción corta ("Ticket 5-3", "Pago de Juan", etc)
-- - notes: Notas adicionales (referencias bancarias, etc)
-- - is_voided: TRUE si la transacción fue anulada
-- - sale_id, expense_id, client_payment_id: IDs para rastrear origen
-- ═══════════════════════════════════════════════════════════════════════════
