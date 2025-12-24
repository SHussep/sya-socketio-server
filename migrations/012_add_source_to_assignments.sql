-- ═══════════════════════════════════════════════════════════════
-- MIGRACIÓN: Agregar campo source a repartidor_assignments
-- ═══════════════════════════════════════════════════════════════
-- Indica el origen de la asignación:
-- - 'desktop': Creada desde la aplicación de escritorio
-- - 'mobile': Creada desde la aplicación móvil
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE repartidor_assignments
ADD COLUMN IF NOT EXISTS source VARCHAR(20) DEFAULT 'desktop';

-- Actualizar registros existentes basándose en terminal_id
-- Si tiene terminal_id, probablemente viene de móvil o desktop con sync
-- Por ahora dejamos el default 'desktop' para los existentes

COMMENT ON COLUMN repartidor_assignments.source IS 'Origen de la asignación: desktop, mobile';
