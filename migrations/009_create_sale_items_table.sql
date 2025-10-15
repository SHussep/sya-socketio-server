-- ═══════════════════════════════════════════════════════════════════════════
-- MIGRACIÓN 009: Crear tabla SALE_ITEMS (Detalles de Ventas)
-- ═══════════════════════════════════════════════════════════════════════════
-- Fecha: 2025-10-14
-- Descripción: Tabla de detalles/items de ventas para app móvil
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- Crear tabla sale_items
CREATE TABLE IF NOT EXISTS sale_items (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER NOT NULL,
  branch_id INTEGER NOT NULL,
  sale_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,

  -- Información del producto
  product_description VARCHAR(500) NOT NULL,
  quantity DECIMAL(10, 3) NOT NULL,

  -- Precios
  list_price DECIMAL(10, 2),
  unit_price DECIMAL(10, 2) NOT NULL,
  line_total DECIMAL(10, 2) NOT NULL,

  -- Descuentos aplicados
  client_discount_type_id INTEGER,
  client_discount_amount DECIMAL(10, 2) DEFAULT 0,
  manual_discount_type_id INTEGER,
  manual_discount_amount DECIMAL(10, 2) DEFAULT 0,
  total_discount DECIMAL(10, 2) DEFAULT 0,

  -- Auditoría
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  -- Sincronización
  remote_id INTEGER,
  synced BOOLEAN DEFAULT FALSE,
  synced_at TIMESTAMP
);

-- Índices para consultas rápidas
CREATE INDEX IF NOT EXISTS idx_sale_items_tenant_branch ON sale_items(tenant_id, branch_id);
CREATE INDEX IF NOT EXISTS idx_sale_items_sale_id ON sale_items(sale_id);
CREATE INDEX IF NOT EXISTS idx_sale_items_product_id ON sale_items(product_id);
CREATE INDEX IF NOT EXISTS idx_sale_items_created_at ON sale_items(created_at);

-- Índice compuesto para consultas de ventas
CREATE INDEX IF NOT EXISTS idx_sale_items_tenant_sale
ON sale_items(tenant_id, sale_id);

-- Foreign keys
ALTER TABLE sale_items
ADD CONSTRAINT fk_sale_items_sale
FOREIGN KEY (sale_id)
REFERENCES sales(id)
ON DELETE CASCADE;

-- Trigger para actualizar updated_at
CREATE OR REPLACE FUNCTION update_sale_items_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_sale_items_updated_at ON sale_items;

CREATE TRIGGER trigger_update_sale_items_updated_at
BEFORE UPDATE ON sale_items
FOR EACH ROW
EXECUTE FUNCTION update_sale_items_updated_at();

-- Trigger para calcular total_discount automáticamente
CREATE OR REPLACE FUNCTION calculate_sale_item_discount()
RETURNS TRIGGER AS $$
BEGIN
  NEW.total_discount = COALESCE(NEW.client_discount_amount, 0) + COALESCE(NEW.manual_discount_amount, 0);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_calculate_sale_item_discount ON sale_items;

CREATE TRIGGER trigger_calculate_sale_item_discount
BEFORE INSERT OR UPDATE ON sale_items
FOR EACH ROW
EXECUTE FUNCTION calculate_sale_item_discount();

-- Vista completa para la app móvil
CREATE OR REPLACE VIEW v_sale_items_complete AS
SELECT
  si.id,
  si.tenant_id,
  si.branch_id,
  b.name as branch_name,
  b.branch_code,
  si.sale_id,
  s.ticket_number,
  s.shift_id,
  s.sale_date,
  si.product_id,
  p.name as product_name,
  p.sku as product_sku,
  si.product_description,
  si.quantity,
  si.list_price,
  si.unit_price,
  si.line_total,
  si.client_discount_type_id,
  si.client_discount_amount,
  si.manual_discount_type_id,
  si.manual_discount_amount,
  si.total_discount,
  si.line_total - si.total_discount as final_line_total,
  si.created_at,
  si.updated_at,
  si.synced,
  si.synced_at
FROM sale_items si
LEFT JOIN branches b ON si.branch_id = b.id
LEFT JOIN sales s ON si.sale_id = s.id
LEFT JOIN products p ON si.product_id = p.id;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- NOTAS:
-- - Cada item representa una línea de producto en una venta
-- - product_description: Descripción del producto al momento de la venta
-- - list_price: Precio de lista original
-- - unit_price: Precio unitario final (después de descuentos de producto)
-- - line_total: Total de la línea (quantity * unit_price)
-- - client_discount_amount: Descuento por cliente especial
-- - manual_discount_amount: Descuento manual aplicado por cajero
-- - total_discount: Suma de descuentos (calculado automáticamente)
-- - final_line_total: Total después de descuentos (en la vista)
-- ═══════════════════════════════════════════════════════════════════════════
