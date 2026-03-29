-- Kardex: Registro de movimientos de inventario por producto
-- Espejo de la tabla KardexEntries de Desktop (SQLite) para trazabilidad centralizada

CREATE TABLE IF NOT EXISTS kardex_entries (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL,
    branch_id INTEGER,
    product_id INTEGER NOT NULL,          -- FK a productos.id (PostgreSQL ID)
    product_global_id TEXT,               -- GlobalId del producto (para resolución cross-device)
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    movement_type TEXT NOT NULL,           -- Venta, Devolucion, AjustePositivo, etc.
    employee_id INTEGER,                  -- FK a employees.id (PostgreSQL ID)
    employee_global_id TEXT,              -- GlobalId del empleado
    quantity_before NUMERIC(12,3) DEFAULT 0,
    quantity_change NUMERIC(12,3) DEFAULT 0,
    quantity_after NUMERIC(12,3) DEFAULT 0,
    description TEXT DEFAULT '',
    sale_id INTEGER,                       -- FK a ventas.id_venta (opcional)
    purchase_id INTEGER,                   -- FK a compras (opcional)
    adjustment_id INTEGER,                 -- FK a ajuste manual (opcional)
    -- Offline-first fields
    global_id TEXT UNIQUE,                 -- UUID para deduplicación
    terminal_id TEXT,                      -- Identificador del dispositivo origen
    source TEXT DEFAULT 'desktop',         -- 'desktop', 'mobile', 'server'
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Índices para consultas frecuentes
CREATE INDEX IF NOT EXISTS idx_kardex_tenant ON kardex_entries(tenant_id);
CREATE INDEX IF NOT EXISTS idx_kardex_product ON kardex_entries(tenant_id, product_id);
CREATE INDEX IF NOT EXISTS idx_kardex_product_global ON kardex_entries(tenant_id, product_global_id);
CREATE INDEX IF NOT EXISTS idx_kardex_timestamp ON kardex_entries(tenant_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_kardex_global_id ON kardex_entries(global_id);
CREATE INDEX IF NOT EXISTS idx_kardex_movement_type ON kardex_entries(tenant_id, movement_type);
