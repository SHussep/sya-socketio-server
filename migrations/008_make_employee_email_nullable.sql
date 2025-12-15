-- Migration: Make employee email nullable
-- Date: 2025-12-16
-- Description: Permite que el campo email de empleados sea NULL
--              ya que no todos los empleados tienen correo electrónico

-- 1. Eliminar la constraint UNIQUE existente de (tenant_id, email)
ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_tenant_id_email_key;

-- 2. Crear un índice parcial que solo aplique cuando email NO es NULL
-- Esto permite múltiples NULLs pero garantiza unicidad cuando hay email
CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_tenant_email_unique
ON employees(tenant_id, email)
WHERE email IS NOT NULL;

-- 3. Verificar que email puede ser NULL (ya debería serlo, pero por si acaso)
-- PostgreSQL no permite cambiar a NULL si ya es NULL, así que usamos DO block
DO $$
BEGIN
    -- Solo ejecutar si la columna tiene NOT NULL
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'employees'
        AND column_name = 'email'
        AND is_nullable = 'NO'
    ) THEN
        ALTER TABLE employees ALTER COLUMN email DROP NOT NULL;
        RAISE NOTICE 'employees.email changed to nullable';
    ELSE
        RAISE NOTICE 'employees.email is already nullable';
    END IF;
END $$;
