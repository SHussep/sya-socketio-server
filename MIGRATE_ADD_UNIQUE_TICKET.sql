-- ================================================================
-- MIGRACIÓN: Agregar restricción UNIQUE para ticket_number
-- ================================================================
-- Objetivo: Prevenir duplicados de ticket_number por branch/tenant
-- Fecha: 22 de Octubre de 2025
--
-- PROBLEMA IDENTIFICADO:
-- En la rama 13 (El Canguro - Principal) hay 2 ventas con ticket_number=15
-- - ID 37: ticket_number 15
-- - ID 41: ticket_number 15
--
-- Esto causa que se muestren como "duplicadas" en la UI
-- ================================================================

-- PASO 1: Identificar duplicados actuales
SELECT
    tenant_id,
    branch_id,
    ticket_number,
    COUNT(*) as count,
    array_agg(id) as ids
FROM sales
GROUP BY tenant_id, branch_id, ticket_number
HAVING COUNT(*) > 1
ORDER BY count DESC;

-- PASO 2: Ver detalles de los duplicados encontrados
SELECT
    id,
    tenant_id,
    branch_id,
    ticket_number,
    total_amount,
    payment_method,
    sale_date,
    created_at
FROM sales
WHERE (tenant_id, branch_id, ticket_number) IN (
    SELECT tenant_id, branch_id, ticket_number
    FROM sales
    GROUP BY tenant_id, branch_id, ticket_number
    HAVING COUNT(*) > 1
)
ORDER BY tenant_id, branch_id, ticket_number, sale_date;

-- PASO 3: Agregar restricción UNIQUE
-- Opción A: Si NO hay duplicados (o después de resolver)
-- ALTER TABLE sales
-- ADD CONSTRAINT unique_ticket_per_branch_tenant
-- UNIQUE(tenant_id, branch_id, ticket_number);

-- Opción B: Si hay duplicados, primero resolver manualmente o:
-- - Eliminar registros duplicados (mantener el más antiguo)
-- - O cambiar uno de los ticket_number

-- ALTERNATIVA: Index UNIQUE (más flexible)
-- Esto previene nuevos duplicados pero permite mantener los existentes
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_ticket_per_branch
ON sales(tenant_id, branch_id, ticket_number)
WHERE deleted_at IS NULL;

-- PASO 4: Verificar que el índice fue creado
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'sales'
AND indexname = 'idx_unique_ticket_per_branch';

-- PASO 5: Informar del resultado
-- ✅ Si el índice se creó exitosamente, los duplicados están prevenidos para el futuro
-- ⚠️ Los duplicados existentes NO serán eliminados por el índice
-- 💡 Para limpiar duplicados, usar este script después de revisar cuál mantener:

-- SCRIPT PARA LIMPIAR DUPLICADOS (manual):
-- DELETE FROM sales
-- WHERE id IN (
--     SELECT id FROM (
--         SELECT
--             id,
--             ROW_NUMBER() OVER (
--                 PARTITION BY tenant_id, branch_id, ticket_number
--                 ORDER BY created_at DESC
--             ) as rn
--         FROM sales
--     ) t
--     WHERE rn > 1
-- );
-- NOTA: Mantiene el registro MÁS ANTIGUO, elimina los más nuevos
