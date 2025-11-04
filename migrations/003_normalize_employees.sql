-- ========================================================================
-- MIGRATION 003: Normalize Employees Schema (3NF Compliance)
-- ========================================================================
-- Objetivo: Eliminar redundancia y mejorar la normalización
--
-- Cambios:
-- 1. Agregar address y phone_number a employees (antes estaba en tabla separada)
-- 2. Eliminar is_active de employee_branches (redundante con employees.is_active)
-- 3. Agregar ON DELETE CASCADE para employee_branches
--
-- ========================================================================

-- PASO 1: Agregar columnas address y phone_number a employees
-- Estos campos estaban en EmployeeDetails en Desktop, ahora centralizados
ALTER TABLE employees
ADD COLUMN IF NOT EXISTS address VARCHAR(500),
ADD COLUMN IF NOT EXISTS phone_number VARCHAR(20);

COMMENT ON COLUMN employees.address IS 'Dirección física del empleado';
COMMENT ON COLUMN employees.phone_number IS 'Número de teléfono del empleado';

-- PASO 2: Eliminar columna is_active de employee_branches (redundante)
-- Un empleado inactivo implica que todas sus relaciones están inactivas
ALTER TABLE employee_branches
DROP COLUMN IF EXISTS is_active;

-- PASO 3: Agregar foreign key constraint con CASCADE DELETE si no existe
-- Cuando se elimina un empleado, automáticamente se eliminan sus relaciones
DO $$
BEGIN
    -- Primero eliminar constraint existente si existe
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'employee_branches_employee_id_fkey'
    ) THEN
        ALTER TABLE employee_branches
        DROP CONSTRAINT employee_branches_employee_id_fkey;
    END IF;

    -- Crear nuevo constraint con CASCADE
    ALTER TABLE employee_branches
    ADD CONSTRAINT employee_branches_employee_id_fkey
    FOREIGN KEY (employee_id)
    REFERENCES employees(id)
    ON DELETE CASCADE;
END $$;

-- PASO 4: Crear índices para mejorar performance
CREATE INDEX IF NOT EXISTS idx_employees_phone ON employees(phone_number) WHERE phone_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_employees_is_active ON employees(is_active);

-- Resultado:
-- ✅ 3NF Compliance: No hay dependencias transitivas
-- ✅ Menos redundancia: is_active solo en employees
-- ✅ Cascade delete: Limpieza automática de employee_branches
-- ✅ Centralización: address y phone_number en employees
