-- Migración: Hacer employee_id nullable en backup_metadata
-- Razón: Los backups creados desde la aplicación Desktop no tienen employee_id asociado

-- Remover la restricción NOT NULL de employee_id
ALTER TABLE backup_metadata
ALTER COLUMN employee_id DROP NOT NULL;

-- Mensaje de éxito
DO $$
BEGIN
    RAISE NOTICE 'Migración completada: employee_id ahora es nullable en backup_metadata';
END $$;
