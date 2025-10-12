-- Migración 006: Agregar timezone a branches
-- =============================================
-- Cada sucursal puede estar en diferente zona horaria de México
-- Desktop configura el timezone al crear la sucursal
-- Mobile hereda el timezone del branch seleccionado

-- 1. Agregar columna timezone a branches
ALTER TABLE branches
ADD COLUMN timezone VARCHAR(50) DEFAULT 'America/Mexico_City';

-- 2. Actualizar branches existentes con timezone por defecto
UPDATE branches
SET timezone = 'America/Mexico_City'
WHERE timezone IS NULL;

-- 3. Agregar NOT NULL constraint
ALTER TABLE branches
ALTER COLUMN timezone SET NOT NULL;

-- 4. Agregar comentario explicativo
COMMENT ON COLUMN branches.timezone IS 'Zona horaria de la sucursal (ej: America/Tijuana, America/Mexico_City, America/Cancun)';

-- Verificación
SELECT id, name, timezone
FROM branches
ORDER BY id;

-- Zonas horarias válidas para México:
-- America/Tijuana       - Pacífico (Baja California)
-- America/Chihuahua     - Montaña (Chihuahua, Sonora)
-- America/Mexico_City   - Centro (CDMX, Guadalajara, Monterrey) [DEFAULT]
-- America/Cancun        - Sureste (Quintana Roo)
