-- =====================================================
-- Migration: 085_drop_remote_id_from_all_tables.sql
-- Descripción: Eliminar remote_id de todas las tablas de PostgreSQL
-- Razón: remote_id solo tiene sentido en Desktop SQLite (apunta al ID de PostgreSQL)
--        En PostgreSQL, el campo 'id' YA ES el identificador único
--        global_id es suficiente para idempotencia
-- =====================================================

-- NOTA: NO tocamos employee_remote_id en tablas guardian (son FK válidos a employees)

-- ========== VENTAS Y DETALLES ==========
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'ventas' AND column_name = 'remote_id'
    ) THEN
        ALTER TABLE ventas DROP COLUMN remote_id;
        RAISE NOTICE '✅ Columna remote_id eliminada de ventas';
    END IF;
END $$;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'ventas_detalle' AND column_name = 'remote_id'
    ) THEN
        ALTER TABLE ventas_detalle DROP COLUMN remote_id;
        RAISE NOTICE '✅ Columna remote_id eliminada de ventas_detalle';
    END IF;
END $$;

-- ========== SHIFTS ==========
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'shifts' AND column_name = 'remote_id'
    ) THEN
        ALTER TABLE shifts DROP COLUMN remote_id;
        RAISE NOTICE '✅ Columna remote_id eliminada de shifts';
    END IF;
END $$;

-- ========== EXPENSES ==========
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'expenses' AND column_name = 'remote_id'
    ) THEN
        ALTER TABLE expenses DROP COLUMN remote_id;
        RAISE NOTICE '✅ Columna remote_id eliminada de expenses';
    END IF;
END $$;

-- ========== EMPLOYEES ==========
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'employees' AND column_name = 'remote_id'
    ) THEN
        ALTER TABLE employees DROP COLUMN remote_id;
        RAISE NOTICE '✅ Columna remote_id eliminada de employees';
    END IF;
END $$;

-- ========== CUSTOMERS ==========
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'customers' AND column_name = 'remote_id'
    ) THEN
        ALTER TABLE customers DROP COLUMN remote_id;
        RAISE NOTICE '✅ Columna remote_id eliminada de customers';
    END IF;
END $$;

-- ========== PRODUCTOS ==========
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'productos' AND column_name = 'remote_id'
    ) THEN
        ALTER TABLE productos DROP COLUMN remote_id;
        RAISE NOTICE '✅ Columna remote_id eliminada de productos';
    END IF;
END $$;

-- ========== REPARTIDOR_ASSIGNMENTS ==========
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'repartidor_assignments' AND column_name = 'remote_id'
    ) THEN
        ALTER TABLE repartidor_assignments DROP COLUMN remote_id;
        RAISE NOTICE '✅ Columna remote_id eliminada de repartidor_assignments';
    END IF;
END $$;

-- ========== CANCELACIONES_BITACORA ==========
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'cancelaciones_bitacora' AND column_name = 'remote_id'
    ) THEN
        ALTER TABLE cancelaciones_bitacora DROP COLUMN remote_id;
        RAISE NOTICE '✅ Columna remote_id eliminada de cancelaciones_bitacora';
    END IF;
END $$;

-- ========== DEPOSITS ==========
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'deposits' AND column_name = 'remote_id'
    ) THEN
        ALTER TABLE deposits DROP COLUMN remote_id;
        RAISE NOTICE '✅ Columna remote_id eliminada de deposits';
    END IF;
END $$;

-- ========== WITHDRAWALS ==========
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'withdrawals' AND column_name = 'remote_id'
    ) THEN
        ALTER TABLE withdrawals DROP COLUMN remote_id;
        RAISE NOTICE '✅ Columna remote_id eliminada de withdrawals';
    END IF;
END $$;

-- ========== PURCHASES (si existe) ==========
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'purchases' AND column_name = 'remote_id'
    ) THEN
        ALTER TABLE purchases DROP COLUMN remote_id;
        RAISE NOTICE '✅ Columna remote_id eliminada de purchases';
    END IF;
END $$;

-- ========== EMPLOYEE_DAILY_METRICS (si existe) ==========
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'employee_daily_metrics' AND column_name = 'remote_id'
    ) THEN
        ALTER TABLE employee_daily_metrics DROP COLUMN remote_id;
        RAISE NOTICE '✅ Columna remote_id eliminada de employee_daily_metrics';
    END IF;
END $$;

-- ========== COMENTARIO FINAL ==========
COMMENT ON SCHEMA public IS 'PostgreSQL schema limpiado - remote_id eliminado (solo relevante en Desktop SQLite)';
