-- =====================================================
-- Migration: 051_create_productos_table.sql
-- Descripción: Crear tabla productos compatible con WinUI Producto.cs
-- =====================================================
-- BLOQUEADOR: Desktop necesita sincronizar productos pero la tabla no existe
-- Esta migración crea la tabla 1:1 con el modelo Producto.cs del Desktop
-- =====================================================

CREATE TABLE IF NOT EXISTS productos (
  id SERIAL PRIMARY KEY,

  -- Scope (siempre filtrar por esto primero)
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  -- ID local del Desktop (preservado para trazabilidad)
  id_producto BIGINT,

  -- Información básica del producto
  descripcion VARCHAR(255) NOT NULL,
  categoria INTEGER,                        -- FK a categorías (tabla separada)

  -- Precios
  precio_compra NUMERIC(10,2) DEFAULT 0,
  precio_venta NUMERIC(10,2) DEFAULT 0,

  -- Configuración de producto
  produccion BOOLEAN DEFAULT FALSE,         -- Es producto de producción propia
  inventariar BOOLEAN DEFAULT FALSE,        -- Se controla inventario
  tipos_de_salida_id INTEGER,               -- FK a TiposDeSalida
  notificar BOOLEAN DEFAULT FALSE,          -- Notificar cuando inventario bajo
  minimo NUMERIC(10,2) DEFAULT 0,           -- Inventario mínimo para notificar
  inventario NUMERIC(10,2) DEFAULT 0,       -- Inventario actual

  -- Relaciones
  proveedor_id INTEGER,                     -- FK a proveedores (tabla separada)
  unidad_medida_id INTEGER,                 -- FK a units_of_measure

  -- Estado y configuración
  eliminado BOOLEAN DEFAULT FALSE,          -- Soft delete
  bascula BOOLEAN DEFAULT FALSE,            -- Requiere báscula/peso
  is_pos_shortcut BOOLEAN DEFAULT FALSE,    -- Aparece en shortcuts del POS

  -- ========== OFFLINE-FIRST SYNC COLUMNS ==========
  global_id VARCHAR(255) UNIQUE NOT NULL,   -- UUID para idempotencia
  synced BOOLEAN NOT NULL DEFAULT TRUE,     -- Siempre TRUE en backend (backend ES remoto)
  remote_id INTEGER,                        -- No usado en backend (para Desktop)
  synced_at TIMESTAMPTZ DEFAULT NOW(),

  -- Auditoría
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ========== ÍNDICES ==========

-- Scope principal
CREATE INDEX IF NOT EXISTS idx_productos_tenant ON productos(tenant_id);

-- GlobalId para búsquedas rápidas de idempotencia
CREATE INDEX IF NOT EXISTS idx_productos_global_id ON productos(global_id);

-- Búsquedas comunes
CREATE INDEX IF NOT EXISTS idx_productos_categoria ON productos(tenant_id, categoria);
CREATE INDEX IF NOT EXISTS idx_productos_proveedor ON productos(tenant_id, proveedor_id);
CREATE INDEX IF NOT EXISTS idx_productos_activos ON productos(tenant_id, eliminado) WHERE eliminado = FALSE;
CREATE INDEX IF NOT EXISTS idx_productos_pos_shortcuts ON productos(tenant_id, is_pos_shortcut) WHERE is_pos_shortcut = TRUE;
CREATE INDEX IF NOT EXISTS idx_productos_inventariables ON productos(tenant_id, inventariar) WHERE inventariar = TRUE;
CREATE INDEX IF NOT EXISTS idx_productos_bajo_stock ON productos(tenant_id, inventario, minimo)
  WHERE inventariar = TRUE AND notificar = TRUE;

-- ========== TRIGGER PARA UPDATED_AT ==========
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'update_productos_updated_at'
  ) THEN
    CREATE TRIGGER update_productos_updated_at
      BEFORE UPDATE ON productos
      FOR EACH ROW
      EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;

-- ========== COMENTARIOS PARA DOCUMENTACIÓN ==========
COMMENT ON TABLE productos IS 'Tabla 1:1 con Desktop Producto.cs - Catálogo de productos con soporte offline-first';
COMMENT ON COLUMN productos.global_id IS 'UUID único para idempotencia en sincronización offline-first';
COMMENT ON COLUMN productos.id_producto IS 'ID local del Desktop (preservado para trazabilidad)';
COMMENT ON COLUMN productos.produccion IS 'TRUE si es producto de producción propia (tortillas, tostadas, etc.)';
COMMENT ON COLUMN productos.inventariar IS 'TRUE si se debe controlar inventario de este producto';
COMMENT ON COLUMN productos.notificar IS 'TRUE si se debe notificar cuando inventario < minimo';
COMMENT ON COLUMN productos.bascula IS 'TRUE si el producto se vende por peso (requiere báscula)';
COMMENT ON COLUMN productos.is_pos_shortcut IS 'TRUE si aparece como acceso directo en el POS';
COMMENT ON COLUMN productos.eliminado IS 'Soft delete - TRUE si el producto está eliminado';
COMMENT ON COLUMN productos.synced IS 'Siempre TRUE en backend - campo usado por Desktop para tracking';
COMMENT ON COLUMN productos.remote_id IS 'No usado en backend - Desktop lo usa para almacenar el ID del servidor';
