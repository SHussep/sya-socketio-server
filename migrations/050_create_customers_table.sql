-- =====================================================
-- Migration: 050_create_customers_table.sql
-- Descripción: Crear tabla customers (clientes) compatible con WinUI Cliente.cs
-- =====================================================
-- BLOQUEADOR: Migration 046 referencia customers(id) pero la tabla no existía
-- Esta migración crea la tabla 1:1 con el modelo Cliente.cs del Desktop
-- =====================================================

CREATE TABLE IF NOT EXISTS customers (
  id SERIAL PRIMARY KEY,

  -- Scope (siempre filtrar por esto primero)
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  -- ID local del Desktop (preservado para trazabilidad)
  id_cliente INTEGER,

  -- Información básica del cliente
  nombre VARCHAR(255) NOT NULL,
  direccion TEXT,
  correo VARCHAR(255),
  telefono VARCHAR(50),
  telefono_secundario VARCHAR(50),

  -- Estado y configuración
  activo BOOLEAN DEFAULT TRUE,
  nota TEXT,

  -- Sistema de crédito
  tiene_credito BOOLEAN DEFAULT FALSE,
  credito_limite NUMERIC(10,2) DEFAULT 0,
  saldo_deudor NUMERIC(10,2) DEFAULT 0,

  -- Sistema de descuentos
  tipo_descuento INTEGER DEFAULT 0,         -- 0=Sin descuento, 1=Porcentaje, 2=Monto fijo
  porcentaje_descuento NUMERIC(5,2) DEFAULT 0,
  monto_descuento_fijo NUMERIC(10,2) DEFAULT 0,
  aplicar_redondeo BOOLEAN DEFAULT FALSE,

  -- Cliente genérico (Público en General)
  is_generic INTEGER DEFAULT 0,             -- 0=Regular, 1=Genérico

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
CREATE INDEX IF NOT EXISTS idx_customers_tenant ON customers(tenant_id);

-- GlobalId para búsquedas rápidas de idempotencia
CREATE INDEX IF NOT EXISTS idx_customers_global_id ON customers(global_id);

-- Cliente genérico único por tenant (índice parcial)
CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_generic_per_tenant
  ON customers(tenant_id) WHERE is_generic = 1;

-- Búsquedas comunes
CREATE INDEX IF NOT EXISTS idx_customers_activo ON customers(tenant_id, activo);
CREATE INDEX IF NOT EXISTS idx_customers_credito ON customers(tenant_id, tiene_credito) WHERE tiene_credito = TRUE;
CREATE INDEX IF NOT EXISTS idx_customers_nombre ON customers(tenant_id, nombre);

-- ========== TRIGGER PARA UPDATED_AT ==========
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'update_customers_updated_at'
  ) THEN
    CREATE TRIGGER update_customers_updated_at
      BEFORE UPDATE ON customers
      FOR EACH ROW
      EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;

-- ========== COMENTARIOS PARA DOCUMENTACIÓN ==========
COMMENT ON TABLE customers IS 'Tabla 1:1 con Desktop Cliente.cs - Catálogo de clientes con soporte offline-first';
COMMENT ON COLUMN customers.global_id IS 'UUID único para idempotencia en sincronización offline-first';
COMMENT ON COLUMN customers.id_cliente IS 'ID local del Desktop (preservado para trazabilidad)';
COMMENT ON COLUMN customers.is_generic IS '0=Cliente regular, 1=Cliente genérico (Público en General)';
COMMENT ON COLUMN customers.tipo_descuento IS '0=Sin descuento, 1=Porcentaje, 2=Monto fijo';
COMMENT ON COLUMN customers.synced IS 'Siempre TRUE en backend - campo usado por Desktop para tracking';
COMMENT ON COLUMN customers.remote_id IS 'No usado en backend - Desktop lo usa para almacenar el ID del servidor';
