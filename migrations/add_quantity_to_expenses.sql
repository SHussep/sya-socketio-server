-- ═══════════════════════════════════════════════════════════════
-- ADD QUANTITY FIELD TO EXPENSES TABLE
-- Purpose: Track quantity (liters for fuel, kg for materials, etc.)
--          Essential for performance analysis: fuel consumption vs delivery weight
-- ═══════════════════════════════════════════════════════════════

-- Add quantity column (nullable, for measurable expenses like fuel)
ALTER TABLE expenses
ADD COLUMN IF NOT EXISTS quantity DECIMAL(10, 3);

-- Add index for quantity queries (useful for reporting)
CREATE INDEX IF NOT EXISTS idx_expenses_quantity ON expenses(quantity) WHERE quantity IS NOT NULL;

-- Add comment to document the field
COMMENT ON COLUMN expenses.quantity IS 'Cantidad medible (litros para combustible, kg para materiales, etc.). Usado para análisis de rendimiento: consumo de combustible vs kilos repartidos';

-- ═══════════════════════════════════════════════════════════════
-- MIGRATION COMPLETE
-- ═══════════════════════════════════════════════════════════════
