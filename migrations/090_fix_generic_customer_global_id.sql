-- =====================================================
-- Migration: 090_fix_generic_customer_global_id.sql
-- Descripción: Corregir GlobalId de clientes genéricos para evitar duplicados
-- =====================================================

-- PROBLEMA: Clientes genéricos tienen UUIDs aleatorios en PostgreSQL
--           pero Desktop usa GlobalId determinista: GENERIC_CUSTOMER_{tenant_id}
--           Esto causa conflicto UNIQUE constraint cuando Desktop intenta crear/sync

-- SOLUCIÓN: Actualizar GlobalId de clientes genéricos existentes a formato determinista

-- ========== ACTUALIZAR GLOBALID DE CLIENTES GENÉRICOS ==========

UPDATE customers
SET global_id = 'GENERIC_CUSTOMER_' || tenant_id
WHERE is_system_generic = TRUE
AND (
    global_id NOT LIKE 'GENERIC_CUSTOMER_%'  -- No tiene formato correcto
    OR global_id IS NULL                      -- No tiene GlobalId
);

-- ========== LOG DE RESULTADOS ==========

DO $$
DECLARE
    v_updated_count INTEGER;
BEGIN
    GET DIAGNOSTICS v_updated_count = ROW_COUNT;
    RAISE NOTICE '✅ Actualizados % clientes genéricos con GlobalId determinista', v_updated_count;
END $$;

-- ========== COMENTARIOS ==========

COMMENT ON COLUMN customers.global_id IS 'UUID offline-first para idempotencia. Clientes genéricos usan: GENERIC_CUSTOMER_{tenant_id}';
