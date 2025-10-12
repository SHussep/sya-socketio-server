-- ═══════════════════════════════════════════════════════════════
-- Migración 004: Agregar max_branches a subscriptions
-- Descripción: Permite limitar el número de sucursales por tier
-- ═══════════════════════════════════════════════════════════════

-- Agregar columna max_branches si no existe
ALTER TABLE subscriptions
ADD COLUMN IF NOT EXISTS max_branches INTEGER DEFAULT 3;

-- Actualizar valores según plan
UPDATE subscriptions SET max_branches = 3 WHERE name = 'Basic';
UPDATE subscriptions SET max_branches = 10 WHERE name = 'Pro';
UPDATE subscriptions SET max_branches = 999999 WHERE name = 'Enterprise'; -- Ilimitado

-- Agregar NOT NULL después de poblar datos
ALTER TABLE subscriptions
ALTER COLUMN max_branches SET NOT NULL;

-- Agregar comentario
COMMENT ON COLUMN subscriptions.max_branches IS 'Número máximo de sucursales permitidas en este plan';

-- Verificar cambios
SELECT id, name, price_monthly, max_branches
FROM subscriptions
ORDER BY price_monthly ASC;
