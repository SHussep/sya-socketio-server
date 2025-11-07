-- =====================================================
-- Migration: 068_add_timestamp_constraints.sql
-- Descripción: Agregar constraints para validar que timestamps RAW sean epoch milliseconds
-- =====================================================

-- ✅ Constraint para ventas.fecha_venta_raw (debe ser epoch ms: 13 dígitos)
-- Rango: 1000000000000 (Sep 2001) a 3000000000000 (Jun 2065)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ck_ventas_fecha_venta_raw_epoch_ms'
    ) THEN
        ALTER TABLE ventas
        ADD CONSTRAINT ck_ventas_fecha_venta_raw_epoch_ms
        CHECK (fecha_venta_raw IS NULL OR (fecha_venta_raw BETWEEN 1000000000000 AND 3000000000000));

        RAISE NOTICE '✅ Constraint ck_ventas_fecha_venta_raw_epoch_ms creado';
    ELSE
        RAISE NOTICE 'ℹ️  Constraint ck_ventas_fecha_venta_raw_epoch_ms ya existe';
    END IF;
END $$;

-- ✅ Constraint para ventas.fecha_liquidacion_raw
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ck_ventas_fecha_liquidacion_raw_epoch_ms'
    ) THEN
        ALTER TABLE ventas
        ADD CONSTRAINT ck_ventas_fecha_liquidacion_raw_epoch_ms
        CHECK (fecha_liquidacion_raw IS NULL OR (fecha_liquidacion_raw BETWEEN 1000000000000 AND 3000000000000));

        RAISE NOTICE '✅ Constraint ck_ventas_fecha_liquidacion_raw_epoch_ms creado';
    ELSE
        RAISE NOTICE 'ℹ️  Constraint ck_ventas_fecha_liquidacion_raw_epoch_ms ya existe';
    END IF;
END $$;

-- ✅ Constraint para device_event_raw en ventas (puede ser epoch ms o .NET ticks)
-- Si es epoch ms: 1000000000000 - 3000000000000 (13 dígitos)
-- Si es .NET ticks: 630000000000000000 - 650000000000000000 (18 dígitos)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ck_ventas_device_event_raw_valid'
    ) THEN
        ALTER TABLE ventas
        ADD CONSTRAINT ck_ventas_device_event_raw_valid
        CHECK (
            device_event_raw IS NULL OR
            (device_event_raw BETWEEN 1000000000000 AND 3000000000000) OR
            (device_event_raw BETWEEN 630000000000000000 AND 650000000000000000)
        );

        RAISE NOTICE '✅ Constraint ck_ventas_device_event_raw_valid creado';
    ELSE
        RAISE NOTICE 'ℹ️  Constraint ck_ventas_device_event_raw_valid ya existe';
    END IF;
END $$;

-- ✅ Comentarios explicativos
COMMENT ON CONSTRAINT ck_ventas_fecha_venta_raw_epoch_ms ON ventas IS 'Valida que fecha_venta_raw sea epoch milliseconds (13 dígitos entre 2001-2065)';
COMMENT ON CONSTRAINT ck_ventas_fecha_liquidacion_raw_epoch_ms ON ventas IS 'Valida que fecha_liquidacion_raw sea epoch milliseconds (13 dígitos entre 2001-2065)';
COMMENT ON CONSTRAINT ck_ventas_device_event_raw_valid ON ventas IS 'Valida que device_event_raw sea epoch ms (13 dígitos) o .NET ticks (18 dígitos)';
