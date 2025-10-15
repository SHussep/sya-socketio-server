-- ═══════════════════════════════════════════════════════════════════════════
-- MIGRACIÓN 006: Crear tabla PURCHASES (Compras)
-- ═══════════════════════════════════════════════════════════════════════════
-- Fecha: 2025-10-14
-- Descripción: Tabla de compras - CRÍTICA para monitoreo desde app móvil
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- Crear tabla purchases
CREATE TABLE IF NOT EXISTS purchases (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL,
  branch_id INTEGER NOT NULL,
  shift_id INTEGER NOT NULL,

  -- Información de la compra
  proveedor_id INTEGER NOT NULL,
  employee_id INTEGER NOT NULL,
  purchase_date TIMESTAMP NOT NULL,

  -- Estado y pago
  status_id INTEGER NOT NULL,
  payment_type_id INTEGER NOT NULL,

  -- Montos
  subtotal DECIMAL(10, 2) NOT NULL DEFAULT 0,
  taxes DECIMAL(10, 2) NOT NULL DEFAULT 0,
  total DECIMAL(10, 2) NOT NULL,
  amount_paid DECIMAL(10, 2) NOT NULL DEFAULT 0,

  -- Detalles adicionales
  notes TEXT,
  invoice_number VARCHAR(100),

  -- Auditoría
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  -- Sincronización
  remote_id INTEGER,
  synced BOOLEAN DEFAULT FALSE,
  synced_at TIMESTAMP
);

-- Índices para consultas rápidas
CREATE INDEX IF NOT EXISTS idx_purchases_tenant_branch ON purchases(tenant_id, branch_id);
CREATE INDEX IF NOT EXISTS idx_purchases_shift_id ON purchases(shift_id);
CREATE INDEX IF NOT EXISTS idx_purchases_proveedor_id ON purchases(proveedor_id);
CREATE INDEX IF NOT EXISTS idx_purchases_employee_id ON purchases(employee_id);
CREATE INDEX IF NOT EXISTS idx_purchases_status_id ON purchases(status_id);
CREATE INDEX IF NOT EXISTS idx_purchases_payment_type ON purchases(payment_type_id);
CREATE INDEX IF NOT EXISTS idx_purchases_date ON purchases(purchase_date);

-- Índice compuesto para consultas de dashboard
CREATE INDEX IF NOT EXISTS idx_purchases_tenant_branch_date
ON purchases(tenant_id, branch_id, purchase_date);

-- Índice compuesto para consultas por turno
CREATE INDEX IF NOT EXISTS idx_purchases_shift_date
ON purchases(shift_id, purchase_date);

-- Foreign keys
ALTER TABLE purchases
ADD CONSTRAINT fk_purchases_shift
FOREIGN KEY (shift_id)
REFERENCES shifts(id)
ON DELETE CASCADE;

-- Trigger para actualizar updated_at
CREATE OR REPLACE FUNCTION update_purchases_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_purchases_updated_at ON purchases;

CREATE TRIGGER trigger_update_purchases_updated_at
BEFORE UPDATE ON purchases
FOR EACH ROW
EXECUTE FUNCTION update_purchases_updated_at();

-- Vista completa para la app móvil
CREATE OR REPLACE VIEW v_purchases_complete AS
SELECT
  p.id,
  p.tenant_id,
  p.branch_id,
  b.name as branch_name,
  b.branch_code,
  p.shift_id,
  p.proveedor_id,
  prov.name as proveedor_name,
  prov.company_name as proveedor_company,
  p.employee_id,
  e.full_name as employee_name,
  e.username as employee_username,
  p.purchase_date,
  p.status_id,
  ps.name as status_name,
  p.payment_type_id,
  pt.name as payment_type_name,
  p.subtotal,
  p.taxes,
  p.total,
  p.amount_paid,
  p.total - p.amount_paid as balance_due,
  p.notes,
  p.invoice_number,
  p.created_at,
  p.updated_at,
  p.synced,
  p.synced_at
FROM purchases p
LEFT JOIN branches b ON p.branch_id = b.id
LEFT JOIN employees e ON p.employee_id = e.id
LEFT JOIN proveedores prov ON p.proveedor_id = prov.id
LEFT JOIN purchase_statuses ps ON p.status_id = ps.id
LEFT JOIN payment_types pt ON p.payment_type_id = pt.id;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- NOTAS:
-- - proveedor_id: Proveedor de la compra
-- - status_id: Estado de la compra (pendiente, completada, cancelada)
-- - payment_type_id: Tipo de pago (efectivo, crédito, transferencia)
-- - amount_paid: Monto pagado (puede ser parcial)
-- - balance_due: Saldo pendiente (calculado en la vista)
-- ═══════════════════════════════════════════════════════════════════════════
