-- ============================================================================
-- MIGRATION: Normalizar schema de ventas y crear tablas maestras
-- ============================================================================
-- Objetivo:
-- 1. Crear tablas maestras normalizadas (payment_types, sale_types)
-- 2. Agregar tabla sales_items (líneas de venta)
-- 3. Actualizar sales con FKs normalizadas
-- 4. Limpiar datos de prueba (excepto Subscripciones)
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. LIMPIAR DATOS DE PRUEBA (solo tablas transaccionales)
-- ============================================================================

-- Solo borrar datos de tablas transaccionales, mantener config (empleados, sucursales, etc.)
DELETE FROM sales;
DELETE FROM expenses;

-- ============================================================================
-- 2. CREAR TABLAS MAESTRAS DE TIPOS
-- ============================================================================

-- Tabla de tipos de pago (valores fijos, raramente cambian)
CREATE TABLE IF NOT EXISTS payment_types (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) NOT NULL UNIQUE,
    description TEXT,
    code VARCHAR(20) NOT NULL UNIQUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Tabla de tipos de venta (Mostrador, Repartidor, etc.)
CREATE TABLE IF NOT EXISTS sale_types (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) NOT NULL UNIQUE,
    description TEXT,
    code VARCHAR(20) NOT NULL UNIQUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- 3. ALTERAR TABLA sales PARA USAR FKs NORMALIZADAS
-- ============================================================================

-- Agregar columnas de FK si no existen
ALTER TABLE sales
ADD COLUMN IF NOT EXISTS payment_type_id INTEGER REFERENCES payment_types(id),
ADD COLUMN IF NOT EXISTS sale_type_id INTEGER REFERENCES sale_types(id);

-- ============================================================================
-- 4. CREAR TABLA sales_items (líneas de venta = VentasDetalle)
-- ============================================================================

CREATE TABLE IF NOT EXISTS sales_items (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id),
    branch_id INTEGER NOT NULL REFERENCES branches(id),
    sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
    product_id INTEGER,
    product_name VARCHAR(255) NOT NULL,
    quantity DECIMAL(10, 2) NOT NULL,
    unit_price DECIMAL(10, 2) NOT NULL,
    list_price DECIMAL(10, 2) NOT NULL,
    customer_discount DECIMAL(10, 2) DEFAULT 0,
    manual_discount DECIMAL(10, 2) DEFAULT 0,
    total_discount DECIMAL(10, 2) DEFAULT 0,
    subtotal DECIMAL(10, 2) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sales_items_tenant_branch ON sales_items(tenant_id, branch_id);
CREATE INDEX IF NOT EXISTS idx_sales_items_sale_id ON sales_items(sale_id);

-- ============================================================================
-- 5. POBLAR TABLAS MAESTRAS CON VALORES INICIALES
-- ============================================================================

-- Limpiar tablas maestras (por si ya existen datos)
DELETE FROM payment_types;
DELETE FROM sale_types;

-- Insertar tipos de pago (IDs deben coincidir con Desktop)
INSERT INTO payment_types (id, name, description, code) VALUES
    (1, 'Efectivo', 'Pago en efectivo', 'cash'),
    (2, 'Tarjeta', 'Pago con tarjeta de crédito/débito', 'card'),
    (3, 'Crédito', 'Venta a crédito', 'credit'),
    (4, 'Mixto', 'Combinación de múltiples métodos de pago', 'mixed')
ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    code = EXCLUDED.code;

-- Insertar tipos de venta (IDs deben coincidir con Desktop)
INSERT INTO sale_types (id, name, description, code) VALUES
    (1, 'Mostrador', 'Venta en mostrador', 'counter'),
    (2, 'Repartidor', 'Venta por repartidor/delivery', 'delivery')
ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    code = EXCLUDED.code;

-- ============================================================================
-- 6. ACTUALIZAR sales PARA USAR FKs (valores por defecto si están NULL)
-- ============================================================================

UPDATE sales
SET payment_type_id = CASE
    WHEN payment_method = 'Efectivo' OR payment_method = 'cash' THEN 1
    WHEN payment_method = 'Tarjeta' OR payment_method = 'card' THEN 2
    WHEN payment_method = 'Crédito' OR payment_method = 'credit' THEN 3
    WHEN payment_method = 'Mixto' OR payment_method = 'mixed' THEN 4
    ELSE 1  -- Default a Efectivo
END
WHERE payment_type_id IS NULL;

UPDATE sales
SET sale_type_id = CASE
    WHEN sale_type = 'counter' THEN 1
    WHEN sale_type = 'delivery' THEN 2
    ELSE 1  -- Default a Mostrador
END
WHERE sale_type_id IS NULL;

-- ============================================================================
-- 7. CREAR VISTAS PARA COMPATIBILIDAD
-- ============================================================================

-- Vista que mapea sales con sus tipos (para retrocompatibilidad)
CREATE OR REPLACE VIEW sales_with_types AS
SELECT
    s.*,
    pt.name AS payment_type_name,
    pt.code AS payment_type_code,
    st.name AS sale_type_name,
    st.code AS sale_type_code
FROM sales s
LEFT JOIN payment_types pt ON s.payment_type_id = pt.id
LEFT JOIN sale_types st ON s.sale_type_id = st.id;

-- Vista de sales_items con información completa
CREATE OR REPLACE VIEW sales_items_with_details AS
SELECT
    si.*,
    s.ticket_number,
    s.total_amount,
    s.employee_id,
    pt.name AS payment_type_name,
    st.name AS sale_type_name
FROM sales_items si
LEFT JOIN sales s ON si.sale_id = s.id
LEFT JOIN payment_types pt ON s.payment_type_id = pt.id
LEFT JOIN sale_types st ON s.sale_type_id = st.id;

-- ============================================================================
-- 8. AÑADIR RESTRICCIONES Y CONSTRAINTS
-- ============================================================================

ALTER TABLE sales
ADD CONSTRAINT fk_sales_payment_type FOREIGN KEY (payment_type_id) REFERENCES payment_types(id),
ADD CONSTRAINT fk_sales_sale_type FOREIGN KEY (sale_type_id) REFERENCES sale_types(id);

-- ============================================================================
-- 9. CREAR ÍNDICES PARA QUERIES COMUNES (APP MÓVIL)
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_sales_with_types ON sales(tenant_id, branch_id, payment_type_id, sale_type_id);
CREATE INDEX IF NOT EXISTS idx_sales_items_by_ticket ON sales_items(sale_id);

COMMIT;

-- ============================================================================
-- RESUMEN DE CAMBIOS
-- ============================================================================
-- ✅ Tablas maestras normalizadas: payment_types, sale_types
-- ✅ Tabla de líneas de venta: sales_items (equivalente a VentasDetalle)
-- ✅ FKs normalizadas en sales table
-- ✅ Vistas para queries comunes
-- ✅ Datos iniciales poblados
-- ✅ Índices para performance
-- ============================================================================
