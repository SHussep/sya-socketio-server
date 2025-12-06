-- ═══════════════════════════════════════════════════════════════
-- MIGRACIÓN: Agregar columnas offline-first a purchases
-- Fecha: 2025-12-07
-- ═══════════════════════════════════════════════════════════════

-- Agregar columnas faltantes a purchases (si no existen)
DO $$
BEGIN
    -- global_id para idempotencia
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'purchases' AND column_name = 'global_id') THEN
        ALTER TABLE purchases ADD COLUMN global_id VARCHAR(36) UNIQUE;
        CREATE INDEX idx_purchases_global_id ON purchases(global_id);
    END IF;

    -- terminal_id para identificar origen
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'purchases' AND column_name = 'terminal_id') THEN
        ALTER TABLE purchases ADD COLUMN terminal_id VARCHAR(100);
    END IF;

    -- local_op_seq para ordenamiento local
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'purchases' AND column_name = 'local_op_seq') THEN
        ALTER TABLE purchases ADD COLUMN local_op_seq BIGINT;
    END IF;

    -- created_local_utc para auditoría
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'purchases' AND column_name = 'created_local_utc') THEN
        ALTER TABLE purchases ADD COLUMN created_local_utc VARCHAR(50);
    END IF;

    -- last_modified_local_utc para tracking de cambios
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'purchases' AND column_name = 'last_modified_local_utc') THEN
        ALTER TABLE purchases ADD COLUMN last_modified_local_utc VARCHAR(50);
    END IF;

    -- supplier_name para denormalización
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'purchases' AND column_name = 'supplier_name') THEN
        ALTER TABLE purchases ADD COLUMN supplier_name VARCHAR(200);
    END IF;

    -- shift_id para vincular con turno
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'purchases' AND column_name = 'shift_id') THEN
        ALTER TABLE purchases ADD COLUMN shift_id INTEGER REFERENCES shifts(id);
    END IF;

    -- subtotal y taxes
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'purchases' AND column_name = 'subtotal') THEN
        ALTER TABLE purchases ADD COLUMN subtotal DECIMAL(12,2) DEFAULT 0;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'purchases' AND column_name = 'taxes') THEN
        ALTER TABLE purchases ADD COLUMN taxes DECIMAL(12,2) DEFAULT 0;
    END IF;

    -- amount_paid para tracking de pagos
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'purchases' AND column_name = 'amount_paid') THEN
        ALTER TABLE purchases ADD COLUMN amount_paid DECIMAL(12,2) DEFAULT 0;
    END IF;

    -- payment_type_id
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'purchases' AND column_name = 'payment_type_id') THEN
        ALTER TABLE purchases ADD COLUMN payment_type_id INTEGER;
    END IF;

    -- invoice_number
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'purchases' AND column_name = 'invoice_number') THEN
        ALTER TABLE purchases ADD COLUMN invoice_number VARCHAR(100);
    END IF;

    -- updated_at
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'purchases' AND column_name = 'updated_at') THEN
        ALTER TABLE purchases ADD COLUMN updated_at TIMESTAMP DEFAULT NOW();
    END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════
-- Crear tabla purchase_details si no existe
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS purchase_details (
    id SERIAL PRIMARY KEY,
    purchase_id INTEGER NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
    product_id BIGINT,
    product_name VARCHAR(200),
    quantity DECIMAL(12,3) DEFAULT 0,
    unit_price DECIMAL(12,2) DEFAULT 0,
    subtotal DECIMAL(12,2) DEFAULT 0,
    global_id VARCHAR(36) UNIQUE,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Índices para purchase_details
CREATE INDEX IF NOT EXISTS idx_purchase_details_purchase_id ON purchase_details(purchase_id);
CREATE INDEX IF NOT EXISTS idx_purchase_details_global_id ON purchase_details(global_id);

-- ═══════════════════════════════════════════════════════════════
-- Verificación
-- ═══════════════════════════════════════════════════════════════
SELECT 'Migración 005_purchases_offline_first completada' AS status;
