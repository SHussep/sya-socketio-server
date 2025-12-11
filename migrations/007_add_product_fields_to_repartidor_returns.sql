-- Migration 007: Add product_id and product_name to repartidor_returns
-- Purpose: Support per-product inventory tracking in returns
-- Created: 2025-12-11

-- ═══════════════════════════════════════════════════════════════════════════
-- Add product_id (optional FK to productos table)
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE repartidor_returns
ADD COLUMN IF NOT EXISTS product_id INTEGER REFERENCES productos(id) ON DELETE SET NULL;

-- ═══════════════════════════════════════════════════════════════════════════
-- Add product_name (denormalized for display, useful when producto is deleted)
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE repartidor_returns
ADD COLUMN IF NOT EXISTS product_name VARCHAR(200);

-- ═══════════════════════════════════════════════════════════════════════════
-- Add index for product_id lookups
-- ═══════════════════════════════════════════════════════════════════════════
CREATE INDEX IF NOT EXISTS idx_repartidor_returns_product
ON repartidor_returns(product_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- Comment for documentation
-- ═══════════════════════════════════════════════════════════════════════════
COMMENT ON COLUMN repartidor_returns.product_id IS 'Reference to producto for inventory tracking';
COMMENT ON COLUMN repartidor_returns.product_name IS 'Denormalized product name for display';

-- Done!
