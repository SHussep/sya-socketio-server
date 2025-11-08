-- =====================================================
-- Migration: 078_cleanup_obsolete_tables.sql
-- Descripción: Eliminar tablas obsoletas que ya no se utilizan
-- Fecha: 2025-11-08
-- =====================================================

-- ============================================================================
-- ELIMINAR TABLA OBSOLETA: scale_disconnections
-- Reemplazada por: scale_disconnection_logs (con offline-first support)
-- ============================================================================

DO $$
BEGIN
    -- Verificar si la tabla existe antes de eliminarla
    IF EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'scale_disconnections'
    ) THEN
        RAISE NOTICE '🗑️ Eliminando tabla obsoleta: scale_disconnections';
        DROP TABLE scale_disconnections;
        RAISE NOTICE '✅ Tabla scale_disconnections eliminada exitosamente';
    ELSE
        RAISE NOTICE 'ℹ️ Tabla scale_disconnections no existe (ya fue eliminada)';
    END IF;
END $$;

-- ============================================================================
-- VERIFICACIÓN FINAL
-- ============================================================================

DO $$
BEGIN
    -- Verificar que la tabla nueva existe
    IF EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'scale_disconnection_logs'
    ) THEN
        RAISE NOTICE '✅ Tabla scale_disconnection_logs existe correctamente';
    ELSE
        RAISE EXCEPTION '❌ ERROR: Tabla scale_disconnection_logs NO existe. Ejecutar migración 077 primero.';
    END IF;

    -- Verificar que la tabla vieja NO existe
    IF NOT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'scale_disconnections'
    ) THEN
        RAISE NOTICE '✅ Tabla obsoleta scale_disconnections ha sido eliminada';
    ELSE
        RAISE EXCEPTION '❌ ERROR: Tabla scale_disconnections aún existe';
    END IF;

    RAISE NOTICE '════════════════════════════════════════════════════';
    RAISE NOTICE '✅ Migración 078 completada exitosamente';
    RAISE NOTICE '════════════════════════════════════════════════════';
END $$;
