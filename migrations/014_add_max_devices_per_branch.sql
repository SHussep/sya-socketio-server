-- ═══════════════════════════════════════════════════════════════════════════
-- Migración 014: Agregar columna max_devices_per_branch a subscriptions
-- ═══════════════════════════════════════════════════════════════════════════
-- Fecha: 2025-10-20
-- Descripción: Agrega límite de dispositivos por sucursal según plan
-- ═══════════════════════════════════════════════════════════════════════════

-- Agregar columna si no existe
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'subscriptions'
        AND column_name = 'max_devices_per_branch'
    ) THEN
        ALTER TABLE subscriptions
        ADD COLUMN max_devices_per_branch INTEGER DEFAULT 3;

        -- Actualizar valores para planes existentes
        UPDATE subscriptions SET max_devices_per_branch = 3 WHERE name = 'Basic';
        UPDATE subscriptions SET max_devices_per_branch = 5 WHERE name = 'Pro';
        UPDATE subscriptions SET max_devices_per_branch = 10 WHERE name = 'Enterprise';

        RAISE NOTICE 'Columna max_devices_per_branch agregada exitosamente';
    ELSE
        RAISE NOTICE 'Columna max_devices_per_branch ya existe';
    END IF;
END
$$;
