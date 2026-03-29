-- ═══════════════════════════════════════════════════════════════
-- Migration 039: Customer Product Prices (Precios Especiales por Cliente)
-- Permite precios especiales y descuentos por producto para cada cliente
-- Compatible con Desktop PreciosEspecialesCliente + idempotencia multi-caja
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS customer_product_prices (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    product_id INTEGER NOT NULL REFERENCES productos(id) ON DELETE CASCADE,

    -- Precio especial fijo (override) - si existe, tiene prioridad sobre porcentaje
    special_price NUMERIC(10,2),

    -- Porcentaje de descuento por producto (0-100)
    discount_percentage NUMERIC(5,2) DEFAULT 0,

    -- Auditoría
    set_by_employee_id INTEGER,
    set_at TIMESTAMPTZ DEFAULT NOW(),
    notes TEXT,

    -- Offline-first sync columns
    global_id VARCHAR(255) UNIQUE NOT NULL,
    terminal_id VARCHAR(255),
    local_op_seq INTEGER,
    created_local_utc TEXT,
    device_event_raw BIGINT,

    -- Soft delete
    is_active BOOLEAN DEFAULT TRUE,

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    -- Un precio por producto por cliente por tenant
    UNIQUE(tenant_id, customer_id, product_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_cpp_tenant_customer
ON customer_product_prices(tenant_id, customer_id)
WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_cpp_global_id
ON customer_product_prices(global_id);

CREATE INDEX IF NOT EXISTS idx_cpp_lookup
ON customer_product_prices(tenant_id, customer_id, product_id)
WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_cpp_updated
ON customer_product_prices(updated_at);
