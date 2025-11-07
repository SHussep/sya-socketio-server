-- =====================================================
-- Migration: 069_deprecate_client_only_columns.sql
-- Descripción: Marcar como deprecadas las columnas que solo pertenecen al cliente
-- =====================================================

-- ⚠️ NOTA: NO eliminamos estas columnas porque pueden estar en uso.
-- Las marcamos como deprecadas con comentarios.
-- En el futuro, cuando todo el código del servidor las ignore, podrían eliminarse.

-- ✅ Marcar columnas deprecadas en ventas
COMMENT ON COLUMN ventas.remote_id IS 'DEPRECATED: Solo para uso del cliente - el servidor no debe usar esto';
COMMENT ON COLUMN ventas.synced IS 'DEPRECATED: Solo para uso del cliente - el servidor siempre considera registros como sincronizados';
COMMENT ON COLUMN ventas.synced_at_raw IS 'DEPRECATED: Solo para uso del cliente - usar updated_at del servidor';

-- ✅ Marcar columnas deprecadas en expenses
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'expenses' AND column_name = 'remote_id'
    ) THEN
        COMMENT ON COLUMN expenses.remote_id IS 'DEPRECATED: Solo para uso del cliente';
    END IF;

    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'expenses' AND column_name = 'synced'
    ) THEN
        COMMENT ON COLUMN expenses.synced IS 'DEPRECATED: Solo para uso del cliente';
    END IF;

    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'expenses' AND column_name = 'synced_at'
    ) THEN
        COMMENT ON COLUMN expenses.synced_at IS 'DEPRECATED: Solo para uso del cliente';
    END IF;
END $$;

-- ✅ Marcar columnas deprecadas en repartidor_assignments
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'repartidor_assignments' AND column_name = 'remote_id'
    ) THEN
        COMMENT ON COLUMN repartidor_assignments.remote_id IS 'DEPRECATED: Solo para uso del cliente';
    END IF;

    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'repartidor_assignments' AND column_name = 'synced'
    ) THEN
        COMMENT ON COLUMN repartidor_assignments.synced IS 'DEPRECATED: Solo para uso del cliente';
    END IF;

    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'repartidor_assignments' AND column_name = 'synced_at'
    ) THEN
        COMMENT ON COLUMN repartidor_assignments.synced_at IS 'DEPRECATED: Solo para uso del cliente';
    END IF;
END $$;

-- ✅ Crear views "limpias" sin columnas deprecadas (opcional para queries del servidor)
CREATE OR REPLACE VIEW ventas_server_view AS
SELECT
    id_venta, tenant_id, branch_id, id_empleado, id_turno,
    estado_venta_id, venta_tipo_id, tipo_pago_id,
    id_repartidor_asignado, id_turno_repartidor,
    ticket_number, id_cliente,
    subtotal, total_descuentos, total, monto_pagado,
    fecha_venta_raw, fecha_liquidacion_raw, fecha_venta_utc, fecha_liquidacion_utc,
    notas, created_at, updated_at,
    -- ✅ Solo columnas offline-first del servidor
    global_id, terminal_id, local_op_seq, created_local_utc, device_event_raw
FROM ventas;

COMMENT ON VIEW ventas_server_view IS 'Vista limpia de ventas sin columnas deprecadas de cliente (remote_id, synced, synced_at_raw)';

-- ⚠️ FUTURO: Cuando el servidor NO use estas columnas, puedes eliminarlas:
-- ALTER TABLE ventas DROP COLUMN IF EXISTS remote_id;
-- ALTER TABLE ventas DROP COLUMN IF EXISTS synced;
-- ALTER TABLE ventas DROP COLUMN IF EXISTS synced_at_raw;
