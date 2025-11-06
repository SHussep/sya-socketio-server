-- =====================================================
-- Migration: 050b_add_customer_fk_to_ventas.sql
-- Descripción: Agregar FK de customers a ventas
-- =====================================================
-- Se ejecuta DESPUÉS de 050_create_customers_table.sql
-- porque ventas se crea en 002 pero customers no existe hasta 050
-- =====================================================

-- Agregar FK constraint a ventas.id_cliente
DO $$
BEGIN
    -- Verificar que la constraint no existe ya
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'ventas_id_cliente_fkey'
        AND table_name = 'ventas'
    ) THEN
        ALTER TABLE ventas
        ADD CONSTRAINT ventas_id_cliente_fkey
        FOREIGN KEY (id_cliente) REFERENCES customers(id) ON DELETE SET NULL;

        RAISE NOTICE '✅ FK ventas.id_cliente → customers.id agregada';
    ELSE
        RAISE NOTICE 'ℹ️  FK ventas.id_cliente → customers.id ya existe';
    END IF;
END $$;

-- Crear índice para búsquedas por cliente
CREATE INDEX IF NOT EXISTS idx_ventas_cliente ON ventas(id_cliente)
WHERE id_cliente IS NOT NULL;

COMMENT ON CONSTRAINT ventas_id_cliente_fkey ON ventas
IS 'FK a customers.id - agregada en migration 050b después de crear customers';
