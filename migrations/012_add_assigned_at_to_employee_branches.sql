-- ═══════════════════════════════════════════════════════════════════════════
-- Migración 012: Agregar columna assigned_at a tabla employee_branches
-- ═══════════════════════════════════════════════════════════════════════════
-- Fecha: 2025-10-19
-- Descripción: Agrega la columna assigned_at como alias de created_at para
--              compatibilidad con rutas que la usan.
-- ═══════════════════════════════════════════════════════════════════════════

-- Verificar si la columna ya existe antes de agregarla
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'employee_branches'
        AND column_name = 'assigned_at'
    ) THEN
        ALTER TABLE employee_branches
        ADD COLUMN assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

        -- Actualizar registros existentes con la fecha de creación
        UPDATE employee_branches
        SET assigned_at = created_at
        WHERE assigned_at IS NULL;

        RAISE NOTICE 'Columna assigned_at agregada a tabla employee_branches';
    ELSE
        RAISE NOTICE 'Columna assigned_at ya existe en tabla employee_branches';
    END IF;
END $$;
