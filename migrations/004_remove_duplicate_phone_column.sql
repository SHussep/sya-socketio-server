-- ========================================================================
-- MIGRATION 004: Remove duplicate phone column from employees
-- ========================================================================
-- Objetivo: Eliminar la columna 'phone' duplicada, conservar 'phone_number'
--
-- Columnas actuales:
--   - phone (antigua, a eliminar)
--   - phone_number (nueva, conservar)
-- ========================================================================

-- Verificar si existe data en 'phone' que no esté en 'phone_number'
-- y migrarla si es necesario
UPDATE employees
SET phone_number = phone
WHERE phone IS NOT NULL
  AND (phone_number IS NULL OR phone_number = '');

-- Eliminar la columna duplicada
ALTER TABLE employees DROP COLUMN IF EXISTS phone;

COMMENT ON COLUMN employees.phone_number IS 'Número de teléfono del empleado (campo único consolidado)';
