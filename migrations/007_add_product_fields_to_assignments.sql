-- Migration 007: Add product_id and product_name to repartidor_assignments
-- Purpose: Store individual product tracking for per-product assignments
-- This allows the mobile app to display the specific product for each assignment

-- Add the product_id column (FK to productos)
ALTER TABLE repartidor_assignments
ADD COLUMN IF NOT EXISTS product_id INTEGER REFERENCES productos(id) ON DELETE SET NULL;

-- Add the product_name column (denormalized for display)
ALTER TABLE repartidor_assignments
ADD COLUMN IF NOT EXISTS product_name VARCHAR(200);

-- Add venta_detalle_id column for traceability
ALTER TABLE repartidor_assignments
ADD COLUMN IF NOT EXISTS venta_detalle_id INTEGER;

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_repartidor_assignments_product_id ON repartidor_assignments(product_id);

-- Comments
COMMENT ON COLUMN repartidor_assignments.product_id IS 'FK to productos table - for per-product inventory tracking';
COMMENT ON COLUMN repartidor_assignments.product_name IS 'Denormalized product name for display (captured at assignment time)';
COMMENT ON COLUMN repartidor_assignments.venta_detalle_id IS 'ID of the sale detail line this assignment corresponds to';
