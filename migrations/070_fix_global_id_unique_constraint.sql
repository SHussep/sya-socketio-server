-- =====================================================
-- Migration: 070_fix_global_id_unique_constraint.sql
-- Descripción: Reemplazar índice parcial con índice UNIQUE completo para ON CONFLICT
-- =====================================================
-- PROBLEMA: ON CONFLICT (global_id) no funciona con índices parciales (WHERE clause)
-- SOLUCIÓN: Crear índice UNIQUE completo sin WHERE clause
-- =====================================================

-- ✅ VENTAS: Reemplazar índice parcial con índice completo
DROP INDEX IF EXISTS uq_ventas_global_id;
CREATE UNIQUE INDEX uq_ventas_global_id ON ventas (global_id);

-- ✅ VENTAS_DETALLE: Reemplazar índice parcial con índice completo
DROP INDEX IF EXISTS uq_ventas_detalle_global_id;
CREATE UNIQUE INDEX uq_ventas_detalle_global_id ON ventas_detalle (global_id);

-- ✅ EXPENSES: Reemplazar índice parcial con índice completo
DROP INDEX IF EXISTS uq_expenses_global_id;
CREATE UNIQUE INDEX uq_expenses_global_id ON expenses (global_id);

-- ✅ REPARTIDOR_ASSIGNMENTS: Reemplazar índice parcial con índice completo
DROP INDEX IF EXISTS uq_repartidor_assignments_global_id;
CREATE UNIQUE INDEX uq_repartidor_assignments_global_id ON repartidor_assignments (global_id);

-- ✅ Comentarios
COMMENT ON INDEX uq_ventas_global_id IS 'UNIQUE constraint para ON CONFLICT - acepta múltiples NULLs pero previene duplicados no-NULL';
COMMENT ON INDEX uq_ventas_detalle_global_id IS 'UNIQUE constraint para ON CONFLICT - acepta múltiples NULLs pero previene duplicados no-NULL';
COMMENT ON INDEX uq_expenses_global_id IS 'UNIQUE constraint para ON CONFLICT - acepta múltiples NULLs pero previene duplicados no-NULL';
COMMENT ON INDEX uq_repartidor_assignments_global_id IS 'UNIQUE constraint para ON CONFLICT - acepta múltiples NULLs pero previene duplicados no-NULL';

-- ℹ️ NOTA: PostgreSQL permite múltiples NULLs en índices UNIQUE por defecto
-- Esto es correcto para nuestro caso: registros antiguos pueden tener global_id NULL,
-- pero nuevos registros DEBEN tener global_id único no-NULL
