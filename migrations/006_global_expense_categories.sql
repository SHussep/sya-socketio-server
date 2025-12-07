-- ═══════════════════════════════════════════════════════════════════════════════
-- MIGRACIÓN: Categorías de Gastos Globales con IDs Canónicos
-- ═══════════════════════════════════════════════════════════════════════════════
-- Esta migración crea una tabla de categorías GLOBALES (sin tenant_id) que
-- son universales para TODOS los tenants. Los IDs son fijos y deben coincidir
-- exactamente con:
-- - Desktop: DomainConstants.cs
-- - Mobile: Flutter constants
-- - API: Esta tabla
-- ═══════════════════════════════════════════════════════════════════════════════

-- 1. Crear tabla de categorías globales
CREATE TABLE IF NOT EXISTS global_expense_categories (
    id INTEGER PRIMARY KEY,  -- NO usar SERIAL, IDs son fijos
    name VARCHAR(100) NOT NULL UNIQUE,
    description TEXT,
    is_measurable BOOLEAN DEFAULT FALSE,
    unit_abbreviation VARCHAR(10),  -- 'kg', 'L', 'pz', etc.
    icon VARCHAR(20),  -- Segoe MDL2 Assets glyph
    is_available BOOLEAN DEFAULT TRUE,
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. Insertar categorías con IDs CANÓNICOS
-- ═══════════════════════════════════════════════════════════════════════════════
-- IMPORTANTE: Estos IDs son INMUTABLES y deben coincidir con DomainConstants.cs
-- ═══════════════════════════════════════════════════════════════════════════════

-- --- Materias Primas (IDs 1-10) ---
INSERT INTO global_expense_categories (id, name, description, is_measurable, unit_abbreviation, icon, sort_order)
VALUES
    (1, 'Maíz / Maseca / Harina', 'Materias primas para producción', TRUE, 'kg', 'E9D2', 1),
    (2, 'Gas LP', 'Gas para producción (tortilladoras)', TRUE, 'L', 'E945', 2),
    (3, 'Combustible Vehículos', 'Gasolina/Diésel para reparto', TRUE, 'L', 'E804', 3)
ON CONFLICT (id) DO NOTHING;

-- --- Operativos (IDs 11-20) ---
INSERT INTO global_expense_categories (id, name, description, is_measurable, unit_abbreviation, icon, sort_order)
VALUES
    (11, 'Consumibles (Papel, Bolsas)', 'Materiales de empaque y consumibles', FALSE, NULL, 'E719', 11),
    (12, 'Refacciones Moto', 'Refacciones para motocicletas de reparto', FALSE, NULL, 'E7EE', 12),
    (13, 'Refacciones Auto', 'Refacciones para vehículos de reparto', FALSE, NULL, 'E804', 13),
    (14, 'Mantenimiento Maquinaria', 'Mantenimiento de tortilladoras y equipo', FALSE, NULL, 'E90F', 14),
    (15, 'Comida', 'Viáticos y alimentación de repartidores', FALSE, NULL, 'E799', 15)
ON CONFLICT (id) DO NOTHING;

-- --- Administrativos (IDs 21-30) ---
INSERT INTO global_expense_categories (id, name, description, is_measurable, unit_abbreviation, icon, sort_order)
VALUES
    (21, 'Sueldos y Salarios', 'Nómina de empleados', FALSE, NULL, 'E716', 21),
    (22, 'Impuestos (ISR, IVA)', 'Obligaciones fiscales', FALSE, NULL, 'E8EF', 22),
    (23, 'Servicios (Luz, Agua, Teléfono)', 'Servicios públicos y comunicación', FALSE, NULL, 'E80F', 23),
    (24, 'Limpieza', 'Materiales y servicios de limpieza', FALSE, NULL, 'E894', 24),
    (25, 'Otros Gastos', 'Gastos no clasificados', FALSE, NULL, 'E712', 25)
ON CONFLICT (id) DO NOTHING;

-- 3. Crear índices
CREATE INDEX IF NOT EXISTS idx_global_expense_categories_name ON global_expense_categories(name);
CREATE INDEX IF NOT EXISTS idx_global_expense_categories_sort ON global_expense_categories(sort_order);

-- 4. Agregar columna global_category_id a expenses si no existe
-- Esta columna referencia a global_expense_categories en lugar de expense_categories por tenant
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'expenses' AND column_name = 'global_category_id') THEN
        ALTER TABLE expenses ADD COLUMN global_category_id INTEGER REFERENCES global_expense_categories(id);
    END IF;
END $$;

-- 5. Migrar datos existentes: Mapear expense_categories a global_expense_categories
-- Esto mapea gastos existentes basándose en el nombre de la categoría
UPDATE expenses e
SET global_category_id = gc.id
FROM expense_categories ec, global_expense_categories gc
WHERE e.category_id = ec.id
  AND e.global_category_id IS NULL
  AND LOWER(gc.name) = LOWER(ec.name);

-- 6. Mapear categorías conocidas por variantes de nombre
-- Gasolina
UPDATE expenses e
SET global_category_id = 3
FROM expense_categories ec
WHERE e.category_id = ec.id
  AND e.global_category_id IS NULL
  AND LOWER(ec.name) IN ('gasolina', 'combustible', 'diesel', 'combustible vehículos');

-- Gas LP
UPDATE expenses e
SET global_category_id = 2
FROM expense_categories ec
WHERE e.category_id = ec.id
  AND e.global_category_id IS NULL
  AND LOWER(ec.name) IN ('gas', 'gas lp', 'gaslp');

-- Comida
UPDATE expenses e
SET global_category_id = 15
FROM expense_categories ec
WHERE e.category_id = ec.id
  AND e.global_category_id IS NULL
  AND LOWER(ec.name) IN ('comida', 'almuerzo', 'viáticos', 'viaticos');

-- 7. Los gastos sin categoría global van a "Otros Gastos" (25)
UPDATE expenses
SET global_category_id = 25
WHERE global_category_id IS NULL;

COMMENT ON TABLE global_expense_categories IS 'Categorías de gastos GLOBALES con IDs fijos. Universales para todos los tenants. Sincronizadas con Desktop (DomainConstants.cs) y Mobile (Flutter).';
COMMENT ON COLUMN expenses.global_category_id IS 'Referencia a la categoría global (IDs canónicos). Reemplaza category_id para sincronización.';
