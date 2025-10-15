-- ═══════════════════════════════════════════════════════════════════════════
-- MIGRACIÓN 004: Mejorar tabla SALES con campos críticos para app móvil
-- ═══════════════════════════════════════════════════════════════════════════
-- Fecha: 2025-10-14
-- Descripción: Agrega campos esenciales para identificar correctamente ventas
--              y su contexto (turno, método de pago, tipo de venta, etc.)
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- 1. Agregar columna shift_id (CRÍTICO - para identificar turno único)
ALTER TABLE sales
ADD COLUMN IF NOT EXISTS shift_id INTEGER;

-- 2. Agregar columnas de identificación única de venta
ALTER TABLE sales
ADD COLUMN IF NOT EXISTS branch_sale_number INTEGER; -- Número de venta en la sucursal

ALTER TABLE sales
ADD COLUMN IF NOT EXISTS shift_sale_number INTEGER; -- Número de venta en el turno

-- 3. Agregar columnas de método y tipo de pago (CRÍTICO)
ALTER TABLE sales
ADD COLUMN IF NOT EXISTS payment_type VARCHAR(50); -- 'cash', 'credit', 'card', 'transfer'

ALTER TABLE sales
ADD COLUMN IF NOT EXISTS is_credit_sale BOOLEAN DEFAULT FALSE; -- Si fue a crédito

ALTER TABLE sales
ADD COLUMN IF NOT EXISTS card_type VARCHAR(50); -- 'visa', 'mastercard', 'amex', etc.

ALTER TABLE sales
ADD COLUMN IF NOT EXISTS card_last_four VARCHAR(4); -- Últimos 4 dígitos de tarjeta

-- 4. Agregar columnas de montos desglosados
ALTER TABLE sales
ADD COLUMN IF NOT EXISTS subtotal DECIMAL(10, 2); -- Subtotal sin descuentos

ALTER TABLE sales
ADD COLUMN IF NOT EXISTS discount_amount DECIMAL(10, 2) DEFAULT 0; -- Monto de descuento

ALTER TABLE sales
ADD COLUMN IF NOT EXISTS tax_amount DECIMAL(10, 2) DEFAULT 0; -- IVA u otros impuestos

ALTER TABLE sales
ADD COLUMN IF NOT EXISTS cash_received DECIMAL(10, 2); -- Efectivo recibido

ALTER TABLE sales
ADD COLUMN IF NOT EXISTS change_given DECIMAL(10, 2); -- Cambio entregado

-- 5. Agregar columnas de estado de venta
ALTER TABLE sales
ADD COLUMN IF NOT EXISTS sale_status VARCHAR(50) DEFAULT 'completed'; -- 'completed', 'cancelled', 'pending', 'refunded'

ALTER TABLE sales
ADD COLUMN IF NOT EXISTS is_cancelled BOOLEAN DEFAULT FALSE;

ALTER TABLE sales
ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMP;

ALTER TABLE sales
ADD COLUMN IF NOT EXISTS cancelled_by INTEGER; -- ID del empleado que canceló

ALTER TABLE sales
ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;

-- 6. Agregar columnas de entrega (para delivery)
ALTER TABLE sales
ADD COLUMN IF NOT EXISTS is_delivery BOOLEAN DEFAULT FALSE;

ALTER TABLE sales
ADD COLUMN IF NOT EXISTS delivery_address TEXT;

ALTER TABLE sales
ADD COLUMN IF NOT EXISTS delivery_fee DECIMAL(10, 2) DEFAULT 0;

ALTER TABLE sales
ADD COLUMN IF NOT EXISTS delivery_status VARCHAR(50); -- 'pending', 'in_transit', 'delivered'

-- 7. Agregar columnas de cliente (para crédito)
ALTER TABLE sales
ADD COLUMN IF NOT EXISTS customer_name VARCHAR(255); -- Nombre del cliente (si aplica)

ALTER TABLE sales
ADD COLUMN IF NOT EXISTS customer_phone VARCHAR(20); -- Teléfono del cliente

ALTER TABLE sales
ADD COLUMN IF NOT EXISTS credit_due_date DATE; -- Fecha de vencimiento si es a crédito

-- 8. Agregar columnas de auditoría mejoradas
ALTER TABLE sales
ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE sales
ADD COLUMN IF NOT EXISTS synced_to_cloud BOOLEAN DEFAULT FALSE; -- Si ya se sincronizó a la nube

ALTER TABLE sales
ADD COLUMN IF NOT EXISTS synced_at TIMESTAMP; -- Cuándo se sincronizó

-- 9. Agregar columnas de referencia (para tickets)
ALTER TABLE sales
ADD COLUMN IF NOT EXISTS receipt_printed BOOLEAN DEFAULT FALSE; -- Si se imprimió ticket

ALTER TABLE sales
ADD COLUMN IF NOT EXISTS receipt_print_count INTEGER DEFAULT 0; -- Cuántas veces se imprimió

ALTER TABLE sales
ADD COLUMN IF NOT EXISTS folio_fiscal VARCHAR(255); -- RFC/Folio fiscal si se facturó

-- 10. Crear índices para mejorar rendimiento de consultas
CREATE INDEX IF NOT EXISTS idx_sales_shift_id ON sales(shift_id);
CREATE INDEX IF NOT EXISTS idx_sales_branch_id ON sales(branch_id);
CREATE INDEX IF NOT EXISTS idx_sales_employee_id ON sales(employee_id);
CREATE INDEX IF NOT EXISTS idx_sales_customer_id ON sales(customer_id);
CREATE INDEX IF NOT EXISTS idx_sales_sale_date ON sales(sale_date);
CREATE INDEX IF NOT EXISTS idx_sales_payment_type ON sales(payment_type);
CREATE INDEX IF NOT EXISTS idx_sales_is_credit ON sales(is_credit_sale);
CREATE INDEX IF NOT EXISTS idx_sales_status ON sales(sale_status);
CREATE INDEX IF NOT EXISTS idx_sales_tenant_branch_date ON sales(tenant_id, branch_id, sale_date);

-- 11. Crear índice compuesto para identificación única de venta
CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_unique_identifier
ON sales(tenant_id, branch_id, shift_id, shift_sale_number)
WHERE shift_id IS NOT NULL AND shift_sale_number IS NOT NULL;

-- 12. Agregar foreign key a shifts (si existe la tabla)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'shifts') THEN
    ALTER TABLE sales
    ADD CONSTRAINT fk_sales_shift
    FOREIGN KEY (shift_id)
    REFERENCES shifts(id)
    ON DELETE SET NULL;
  END IF;
END $$;

-- 13. Crear trigger para actualizar updated_at automáticamente
CREATE OR REPLACE FUNCTION update_sales_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_sales_updated_at ON sales;

CREATE TRIGGER trigger_update_sales_updated_at
BEFORE UPDATE ON sales
FOR EACH ROW
EXECUTE FUNCTION update_sales_updated_at();

-- 14. Actualizar payment_method para que sea más específico (si ya existe data)
-- Convertir valores antiguos a nuevo formato
UPDATE sales
SET payment_type = payment_method
WHERE payment_type IS NULL AND payment_method IS NOT NULL;

-- 15. Crear vista útil para consultas de la app móvil
CREATE OR REPLACE VIEW v_sales_complete AS
SELECT
  s.id,
  s.tenant_id,
  s.branch_id,
  b.name as branch_name,
  b.branch_code,
  s.shift_id,
  s.employee_id,
  e.full_name as employee_name,
  e.username as employee_username,
  s.customer_id,
  s.customer_name,
  s.ticket_number,
  s.branch_sale_number,
  s.shift_sale_number,
  s.total_amount,
  s.subtotal,
  s.discount_amount,
  s.tax_amount,
  s.payment_type,
  s.payment_method,
  s.is_credit_sale,
  s.card_type,
  s.sale_type,
  s.is_delivery,
  s.delivery_person_id,
  s.delivery_fee,
  s.sale_status,
  s.is_cancelled,
  s.sale_date,
  s.created_at,
  s.updated_at,
  -- Construir ticket display (ej: "3-6" = Turno 3, Venta 6)
  CONCAT(s.shift_id, '-', s.shift_sale_number) as ticket_display,
  -- Construir identificador único completo
  CONCAT(s.branch_id, '-', s.shift_id, '-', s.shift_sale_number) as unique_sale_id
FROM sales s
LEFT JOIN branches b ON s.branch_id = b.id
LEFT JOIN employees e ON s.employee_id = e.id;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- NOTAS IMPORTANTES:
-- ═══════════════════════════════════════════════════════════════════════════
--
-- IDENTIFICACIÓN ÚNICA DE VENTA:
-- - branch_id: Identifica la sucursal
-- - shift_id: Identifica el turno específico
-- - shift_sale_number: Número secuencial de venta dentro del turno
-- - ticket_number: Número de ticket para display (puede ser "3-6")
--
-- EJEMPLO:
-- ticket_display = "3-6" significa: Turno #3, Venta #6 del turno
-- unique_sale_id = "1-3-6" significa: Sucursal #1, Turno #3, Venta #6
--
-- TIPOS DE PAGO (payment_type):
-- - 'cash': Efectivo
-- - 'credit': A crédito (fiado)
-- - 'card': Tarjeta de crédito/débito
-- - 'transfer': Transferencia bancaria
-- - 'mixed': Pago mixto
--
-- ESTADOS DE VENTA (sale_status):
-- - 'completed': Venta completada
-- - 'cancelled': Venta cancelada
-- - 'pending': Venta pendiente
-- - 'refunded': Venta reembolsada
--
-- ═══════════════════════════════════════════════════════════════════════════
