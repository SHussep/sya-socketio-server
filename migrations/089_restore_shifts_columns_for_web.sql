-- =====================================================
-- Migration: 089_restore_shifts_columns_for_web.sql
-- Descripción: Restaurar columnas eliminadas en 087 para endpoints web/móvil
-- =====================================================

-- PROBLEMA: Migration 087 eliminó columnas que el endpoint /api/shifts/open aún usa
-- SOLUCIÓN: Restaurar columnas necesarias para endpoints web/móvil

-- NOTA: Desktop NO sincroniza estos campos (los maneja localmente en cash_cuts)
--       Estas columnas son solo para turnos abiertos desde web/móvil

-- ========== RESTAURAR COLUMNAS ==========

-- initial_amount: Monto inicial cuando se abre turno desde web/móvil
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS initial_amount NUMERIC(10, 2) DEFAULT 0;

-- is_cash_cut_open: Indica si el turno está activo (usado por web/móvil)
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS is_cash_cut_open BOOLEAN DEFAULT TRUE;

-- transaction_counter: Contador de transacciones (usado por web/móvil)
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS transaction_counter INTEGER DEFAULT 0;

-- ========== COMENTARIOS ==========

COMMENT ON COLUMN shifts.initial_amount IS 'Monto inicial (solo para turnos web/móvil - Desktop usa cash_cuts)';
COMMENT ON COLUMN shifts.is_cash_cut_open IS 'Turno activo (solo web/móvil - Desktop usa estado local)';
COMMENT ON COLUMN shifts.transaction_counter IS 'Contador de transacciones (solo web/móvil)';
COMMENT ON TABLE shifts IS 'Turnos - Desktop sincroniza desde local, Web/Móvil crea directamente';
