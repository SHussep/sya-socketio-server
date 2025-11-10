-- =====================================================
-- Migration: 071_create_generic_customer_per_tenant.sql
-- Descripción: Crear cliente "Público en General" automático por tenant
-- =====================================================

-- ✅ PASO 1: Agregar columna is_system_generic para identificar el cliente genérico
ALTER TABLE customers ADD COLUMN IF NOT EXISTS is_system_generic BOOLEAN DEFAULT FALSE;

-- ✅ PASO 2: Crear índice UNIQUE parcial - Solo UN genérico por tenant
CREATE UNIQUE INDEX IF NOT EXISTS uq_customers_generic_per_tenant
    ON customers (tenant_id)
    WHERE is_system_generic = TRUE;

-- ✅ PASO 3: Crear función para obtener o crear cliente genérico de un tenant
CREATE OR REPLACE FUNCTION get_or_create_generic_customer(p_tenant_id INTEGER, p_branch_id INTEGER)
RETURNS INTEGER AS $$
DECLARE
    v_customer_id INTEGER;
BEGIN
    -- Intentar encontrar el cliente genérico existente
    SELECT id INTO v_customer_id
    FROM customers
    WHERE tenant_id = p_tenant_id
    AND is_system_generic = TRUE
    LIMIT 1;

    -- Si no existe, crearlo
    IF v_customer_id IS NULL THEN
        INSERT INTO customers (
            tenant_id,
            nombre,
            telefono,
            direccion,
            correo,
            is_system_generic,
            nota,
            global_id,
            synced,
            created_at,
            updated_at
        ) VALUES (
            p_tenant_id,
            'Público en General',
            'N/A',
            'N/A',
            NULL,
            TRUE,
            'Cliente genérico del sistema - No editar ni eliminar',
            'GENERIC_CUSTOMER_' || p_tenant_id,
            TRUE,
            NOW(),
            NOW()
        )
        RETURNING id INTO v_customer_id;

        RAISE NOTICE '✅ Cliente genérico creado para tenant % con ID %', p_tenant_id, v_customer_id;
    END IF;

    RETURN v_customer_id;
END;
$$ LANGUAGE plpgsql;

-- ✅ PASO 4: Crear clientes genéricos para todos los tenants existentes
DO $$
DECLARE
    tenant_record RECORD;
    generic_customer_id INTEGER;
BEGIN
    FOR tenant_record IN SELECT id FROM tenants LOOP
        -- Llamar a la función para crear/obtener genérico
        generic_customer_id := get_or_create_generic_customer(tenant_record.id, NULL);

        RAISE NOTICE '✅ Tenant % tiene cliente genérico con ID %', tenant_record.id, generic_customer_id;
    END LOOP;
END $$;

-- ✅ PASO 5: Actualizar clientes existentes que parecen ser genéricos
-- (nombre = "Público en General" o similar)
UPDATE customers
SET is_system_generic = TRUE,
    nota = 'Cliente genérico del sistema - No editar ni eliminar'
WHERE (
    LOWER(nombre) LIKE '%público%general%'
    OR LOWER(nombre) LIKE '%publico%general%'
    OR LOWER(nombre) = 'generico'
    OR LOWER(nombre) = 'generic customer'
)
AND (is_system_generic = FALSE OR is_system_generic IS NULL);

-- ✅ PASO 6: Crear trigger para prevenir eliminación del cliente genérico
CREATE OR REPLACE FUNCTION prevent_generic_customer_delete()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.is_system_generic = TRUE THEN
        RAISE EXCEPTION 'No se puede eliminar el cliente genérico del sistema (ID: %)', OLD.id;
    END IF;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_generic_customer_delete ON customers;
CREATE TRIGGER trg_prevent_generic_customer_delete
    BEFORE DELETE ON customers
    FOR EACH ROW
    EXECUTE FUNCTION prevent_generic_customer_delete();

-- ✅ PASO 7: Comentarios
COMMENT ON COLUMN customers.is_system_generic IS 'TRUE si es el cliente "Público en General" del sistema - No editar ni eliminar';
COMMENT ON FUNCTION get_or_create_generic_customer IS 'Obtiene o crea el cliente genérico para un tenant específico';
COMMENT ON TRIGGER trg_prevent_generic_customer_delete ON customers IS 'Previene eliminación accidental del cliente genérico del sistema';
