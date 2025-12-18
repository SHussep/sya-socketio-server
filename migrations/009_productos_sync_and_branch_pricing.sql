-- ═══════════════════════════════════════════════════════════════════════════════
-- MIGRATION 009: Productos Sync Columns + Branch Pricing Table
-- ═══════════════════════════════════════════════════════════════════════════════
-- Fecha: 2025-12-18
-- Descripción:
--   1. Agrega columnas offline-first a la tabla productos para sincronización
--   2. Crea tabla productos_branch_precios para precios diferentes por sucursal
-- ═══════════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════════
-- PARTE 1: Agregar columnas de sincronización a productos
-- ═══════════════════════════════════════════════════════════════════════════════

-- Terminal que creó/modificó el producto
ALTER TABLE productos
ADD COLUMN IF NOT EXISTS terminal_id VARCHAR(255);

-- Secuencia local de operaciones
ALTER TABLE productos
ADD COLUMN IF NOT EXISTS local_op_seq INTEGER;

-- Timestamp de creación local (ISO 8601 string)
ALTER TABLE productos
ADD COLUMN IF NOT EXISTS created_local_utc TEXT;

-- Timestamp raw del dispositivo (.NET ticks)
ALTER TABLE productos
ADD COLUMN IF NOT EXISTS device_event_raw BIGINT;

-- Última modificación local
ALTER TABLE productos
ADD COLUMN IF NOT EXISTS last_modified_local_utc TEXT;

-- Flag: Pendiente de sincronizar UPDATE
ALTER TABLE productos
ADD COLUMN IF NOT EXISTS needs_update BOOLEAN DEFAULT FALSE;

-- Flag: Pendiente de sincronizar DELETE (soft)
ALTER TABLE productos
ADD COLUMN IF NOT EXISTS needs_delete BOOLEAN DEFAULT FALSE;

-- Índice para buscar productos pendientes de sync
CREATE INDEX IF NOT EXISTS idx_productos_needs_sync
ON productos(tenant_id, needs_update)
WHERE needs_update = TRUE OR needs_delete = TRUE;

-- ═══════════════════════════════════════════════════════════════════════════════
-- PARTE 2: Tabla de precios por sucursal
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS productos_branch_precios (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    producto_id INTEGER NOT NULL REFERENCES productos(id) ON DELETE CASCADE,

    -- Pricing override for this branch
    precio_venta NUMERIC(10,2) NOT NULL,
    precio_compra NUMERIC(10,2),

    -- Offline-first sync columns
    global_id VARCHAR(255) UNIQUE NOT NULL,
    terminal_id VARCHAR(255),
    local_op_seq INTEGER,
    created_local_utc TEXT,
    last_modified_local_utc TEXT,

    -- Soft delete
    eliminado BOOLEAN DEFAULT FALSE,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Un producto solo puede tener un precio override por sucursal
    UNIQUE(tenant_id, branch_id, producto_id)
);

-- Índices para búsqueda eficiente
CREATE INDEX IF NOT EXISTS idx_productos_branch_precios_lookup
ON productos_branch_precios(tenant_id, branch_id, producto_id)
WHERE eliminado = FALSE;

CREATE INDEX IF NOT EXISTS idx_productos_branch_precios_global_id
ON productos_branch_precios(global_id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- PARTE 3: Comentarios descriptivos
-- ═══════════════════════════════════════════════════════════════════════════════

COMMENT ON COLUMN productos.terminal_id IS 'ID de la terminal que creó/modificó (offline-first)';
COMMENT ON COLUMN productos.local_op_seq IS 'Secuencia local de operaciones para ordenamiento';
COMMENT ON COLUMN productos.needs_update IS 'Pendiente de sincronizar UPDATE desde Desktop';
COMMENT ON COLUMN productos.needs_delete IS 'Pendiente de sincronizar DELETE desde Desktop (soft)';

COMMENT ON TABLE productos_branch_precios IS 'Precios específicos por sucursal (override del precio base del producto)';
COMMENT ON COLUMN productos_branch_precios.precio_venta IS 'Precio de venta para esta sucursal específica';
COMMENT ON COLUMN productos_branch_precios.precio_compra IS 'Precio de compra para esta sucursal (opcional)';

-- ═══════════════════════════════════════════════════════════════════════════════
-- FIN DE LA MIGRACIÓN
-- ═══════════════════════════════════════════════════════════════════════════════
