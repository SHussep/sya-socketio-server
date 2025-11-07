-- =====================================================
-- Migration: 073_fix_ventas_ticket_unique_with_shift.sql
-- Descripción: Arreglar índice UNIQUE de ventas para incluir id_turno
-- Problema: TicketNumber se reinicia por turno, causando duplicados
-- =====================================================

-- ❌ Problema: El índice solo incluía (tenant_id, branch_id, ticket_number)
-- ✅ Solución: Incluir id_turno para permitir TicketNumber=1 en diferentes turnos

-- 1. Eliminar índice viejo sin id_turno
DROP INDEX IF EXISTS ventas_uq_ticket_per_branch;

-- 2. Crear nuevo índice que incluye id_turno
CREATE UNIQUE INDEX ventas_uq_ticket_per_branch_shift
    ON ventas(tenant_id, branch_id, id_turno, ticket_number);

-- 3. Comentario explicativo
COMMENT ON INDEX ventas_uq_ticket_per_branch_shift IS
'Garantiza unicidad de ticket_number por turno. TicketNumber se reinicia en cada nuevo turno (TransactionCounter).';

-- 4. Verificación
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE indexname = 'ventas_uq_ticket_per_branch_shift'
    ) THEN
        RAISE NOTICE '✅ Índice ventas_uq_ticket_per_branch_shift creado exitosamente';
    ELSE
        RAISE EXCEPTION '❌ Error: Índice no fue creado';
    END IF;
END $$;
