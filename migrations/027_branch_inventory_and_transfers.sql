-- Migration 027: Branch-level inventory + Inter-branch transfers
-- Enables per-branch inventory tracking and atomic transfers between branches.
-- Previously, productos.inventario was global per tenant.
-- Now, branch_inventory holds stock per branch.

-- ═══════════════════════════════════════════════════════════════
-- TABLE: branch_inventory — Stock por sucursal
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS branch_inventory (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    producto_id INTEGER NOT NULL REFERENCES productos(id) ON DELETE CASCADE,

    quantity NUMERIC(10,2) NOT NULL DEFAULT 0,
    minimum NUMERIC(10,2) NOT NULL DEFAULT 0,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE(tenant_id, branch_id, producto_id)
);

CREATE INDEX IF NOT EXISTS idx_branch_inv_lookup
    ON branch_inventory(tenant_id, branch_id, producto_id);

CREATE INDEX IF NOT EXISTS idx_branch_inv_low_stock
    ON branch_inventory(tenant_id, branch_id)
    WHERE quantity <= minimum;

-- ═══════════════════════════════════════════════════════════════
-- TABLE: inventory_transfers — Registro de transferencias
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS inventory_transfers (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    from_branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
    to_branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,

    status VARCHAR(20) NOT NULL DEFAULT 'completed'
        CHECK (status IN ('completed', 'cancelled')),

    notes TEXT,

    created_by_employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
    cancelled_by_employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    cancelled_at TIMESTAMPTZ,
    cancellation_reason TEXT,

    global_id VARCHAR(255) UNIQUE NOT NULL,
    terminal_id VARCHAR(255),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_transfers_tenant
    ON inventory_transfers(tenant_id);
CREATE INDEX IF NOT EXISTS idx_transfers_from_branch
    ON inventory_transfers(from_branch_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transfers_to_branch
    ON inventory_transfers(to_branch_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transfers_global_id
    ON inventory_transfers(global_id);

-- ═══════════════════════════════════════════════════════════════
-- TABLE: inventory_transfer_items — Detalle de productos transferidos
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS inventory_transfer_items (
    id SERIAL PRIMARY KEY,
    transfer_id INTEGER NOT NULL REFERENCES inventory_transfers(id) ON DELETE CASCADE,
    producto_id INTEGER NOT NULL REFERENCES productos(id) ON DELETE RESTRICT,

    quantity NUMERIC(10,2) NOT NULL CHECK (quantity > 0),
    product_name VARCHAR(255) NOT NULL,
    unit_abbreviation VARCHAR(10) DEFAULT 'kg',

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_transfer_items_transfer
    ON inventory_transfer_items(transfer_id);
CREATE INDEX IF NOT EXISTS idx_transfer_items_product
    ON inventory_transfer_items(producto_id);

-- ═══════════════════════════════════════════════════════════════
-- DATA MIGRATION: Populate branch_inventory from existing productos.inventario
-- Assigns current global stock to the FIRST active branch of each tenant.
-- Creates zero-stock rows for other branches.
-- ═══════════════════════════════════════════════════════════════

-- Step 1: Assign existing inventario to the first branch (by created_at)
INSERT INTO branch_inventory (tenant_id, branch_id, producto_id, quantity, minimum)
SELECT DISTINCT ON (p.id)
    p.tenant_id,
    b.id AS branch_id,
    p.id AS producto_id,
    COALESCE(p.inventario, 0) AS quantity,
    COALESCE(p.minimo, 0) AS minimum
FROM productos p
JOIN branches b ON b.tenant_id = p.tenant_id
WHERE p.eliminado = FALSE
ORDER BY p.id, b.created_at ASC
ON CONFLICT (tenant_id, branch_id, producto_id) DO NOTHING;

-- Step 2: Create zero-stock rows for remaining branches
INSERT INTO branch_inventory (tenant_id, branch_id, producto_id, quantity, minimum)
SELECT
    p.tenant_id,
    b.id AS branch_id,
    p.id AS producto_id,
    0 AS quantity,
    0 AS minimum
FROM productos p
CROSS JOIN branches b
WHERE b.tenant_id = p.tenant_id
  AND p.eliminado = FALSE
  AND NOT EXISTS (
      SELECT 1 FROM branch_inventory bi
      WHERE bi.producto_id = p.id AND bi.branch_id = b.id AND bi.tenant_id = p.tenant_id
  )
ON CONFLICT (tenant_id, branch_id, producto_id) DO NOTHING;

-- Mark productos.inventario as deprecated
COMMENT ON COLUMN productos.inventario IS 'DEPRECATED: Use branch_inventory table. Kept for backward compatibility during transition.';
