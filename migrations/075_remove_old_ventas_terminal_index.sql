-- =====================================================
-- Migration: 075_remove_old_ventas_terminal_index.sql
-- Descripción: Eliminar índice viejo uq_ventas_ticket_per_terminal que NO incluye id_turno
-- Problema: Este índice causa conflictos cuando diferentes turnos tienen el mismo ticket_number
-- =====================================================

-- El índice viejo uq_ventas_ticket_per_terminal es:
--   (tenant_id, branch_id, ticket_number, terminal_id)
--
-- Esto causa error cuando:
--   Turno 1, Ticket 1 → (1, 1, 1, ABC) ✅
--   Turno 2, Ticket 1 → (1, 1, 1, ABC) ❌ DUPLICATE KEY
--
-- El índice correcto (ventas_uq_ticket_per_branch_shift) ya existe con:
--   (tenant_id, branch_id, id_turno, ticket_number)
--
-- Que permite:
--   Turno 1, Ticket 1 → (1, 1, 1, 1) ✅
--   Turno 2, Ticket 1 → (1, 1, 2, 1) ✅ (diferente turno)

-- Eliminar el índice viejo que causa conflictos
DROP INDEX IF EXISTS uq_ventas_ticket_per_terminal;

-- Verificación
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE indexname = 'uq_ventas_ticket_per_terminal'
    ) THEN
        RAISE NOTICE '✅ Índice viejo uq_ventas_ticket_per_terminal eliminado exitosamente';
    ELSE
        RAISE EXCEPTION '❌ Error: Índice uq_ventas_ticket_per_terminal aún existe';
    END IF;

    -- Verificar que el índice correcto existe
    IF EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE indexname = 'ventas_uq_ticket_per_branch_shift'
    ) THEN
        RAISE NOTICE '✅ Índice correcto ventas_uq_ticket_per_branch_shift existe';
    ELSE
        RAISE EXCEPTION '❌ Error: Índice ventas_uq_ticket_per_branch_shift NO existe';
    END IF;
END $$;
