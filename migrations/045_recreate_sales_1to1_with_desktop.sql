-- =====================================================
-- Migration: 045_recreate_sales_1to1_with_desktop.sql
-- Descripción: Recrear tablas de ventas 1:1 con Desktop
-- =====================================================
-- Basado en arquitectura sugerida por programador:
-- - Estructura idéntica a Desktop SQLite
-- - Timestamps raw (bigint) con columnas generadas
-- - Índices por scope (tenant, branch)
-- - Sin campos redundantes
-- =====================================================

-- 1. DROP TABLAS VIEJAS
DROP TABLE IF EXISTS sales_items_with_details CASCADE;
DROP TABLE IF EXISTS sales_with_types CASCADE;
DROP TABLE IF EXISTS v_sales_complete CASCADE;
DROP TABLE IF EXISTS sale_items CASCADE;
DROP TABLE IF EXISTS sales_items CASCADE;
DROP TABLE IF EXISTS sales CASCADE;

-- 2. CREAR TABLA VENTAS (1:1 con Desktop)
CREATE TABLE ventas (
  id_venta              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- Scope (siempre filtrar por esto primero)
  tenant_id             INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id             INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,

  -- Estado y asignaciones
  estado_venta_id       INTEGER NOT NULL DEFAULT 3, -- 1=Borrador, 2=Asignada, 3=Completada, 4=Cancelada, 5=Liquidada
  id_repartidor_asignado INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  id_turno_repartidor   INTEGER REFERENCES shifts(id) ON DELETE SET NULL,
  id_turno              INTEGER NOT NULL REFERENCES shifts(id) ON DELETE RESTRICT,

  -- Relaciones
  id_empleado           INTEGER NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  id_cliente            INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  venta_tipo_id         INTEGER, -- 1=Mostrador, 2=Repartidor
  tipo_pago_id          INTEGER, -- FK a payment_types

  -- Folio visible
  ticket_number         INTEGER NOT NULL,

  -- Timestamps RAW (preserva .NET ticks exactos)
  fecha_venta_raw       BIGINT,
  fecha_liquidacion_raw BIGINT,

  -- Montos
  subtotal              NUMERIC(14,2) DEFAULT 0,
  total_descuentos      NUMERIC(14,2) DEFAULT 0,
  total                 NUMERIC(14,2) NOT NULL,
  monto_pagado          NUMERIC(14,2) DEFAULT 0,

  -- Notas
  notas                 TEXT,

  -- Sincronización
  remote_id             INTEGER, -- No usado en backend
  synced                BOOLEAN NOT NULL DEFAULT true, -- Siempre true en backend
  synced_at_raw         BIGINT,

  -- Columnas generadas para queries legibles (epoch_ms)
  -- Si Desktop envía .NET ticks, comentar estas y usar fórmula ticks
  fecha_venta_utc       TIMESTAMPTZ GENERATED ALWAYS AS
                        (CASE
                          WHEN fecha_venta_raw IS NULL THEN NULL
                          ELSE to_timestamp((fecha_venta_raw)::double precision / 1000.0)
                        END) STORED,

  fecha_liquidacion_utc TIMESTAMPTZ GENERATED ALWAYS AS
                        (CASE
                          WHEN fecha_liquidacion_raw IS NULL THEN NULL
                          ELSE to_timestamp((fecha_liquidacion_raw)::double precision / 1000.0)
                        END) STORED,

  synced_at_utc         TIMESTAMPTZ GENERATED ALWAYS AS
                        (CASE
                          WHEN synced_at_raw IS NULL THEN NULL
                          ELSE to_timestamp((synced_at_raw)::double precision / 1000.0)
                        END) STORED,

  -- Auditoría
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. CREAR TABLA VENTAS_DETALLE (1:1 con Desktop)
CREATE TABLE ventas_detalle (
  id_venta_detalle      INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- FK a venta
  id_venta              INTEGER NOT NULL REFERENCES ventas(id_venta) ON DELETE CASCADE,

  -- Producto
  id_producto           BIGINT NOT NULL, -- BIGINT porque Desktop usa long
  descripcion_producto  VARCHAR(255) NOT NULL,

  -- Cantidades y precios
  cantidad              NUMERIC(14,3) NOT NULL, -- 3 decimales para pesar
  precio_lista          NUMERIC(14,2) NOT NULL,
  precio_unitario       NUMERIC(14,2) NOT NULL,
  total_linea           NUMERIC(14,2) NOT NULL,

  -- Descuentos
  tipo_descuento_cliente_id  INTEGER,
  monto_cliente_descuento    NUMERIC(14,2) DEFAULT 0,
  tipo_descuento_manual_id   INTEGER,
  monto_manual_descuento     NUMERIC(14,2) DEFAULT 0,

  -- Auditoría
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. ÍNDICES DE UNICIDAD
-- Folio único por sucursal
CREATE UNIQUE INDEX ventas_uq_ticket_per_branch
  ON ventas(tenant_id, branch_id, ticket_number);

-- 5. ÍNDICES DE RENDIMIENTO (scope primero)
CREATE INDEX ventas_scope_time_idx    ON ventas(tenant_id, branch_id, fecha_venta_utc DESC);
CREATE INDEX ventas_scope_turno_idx   ON ventas(tenant_id, branch_id, id_turno);
CREATE INDEX ventas_scope_emp_idx     ON ventas(tenant_id, branch_id, id_empleado);
CREATE INDEX ventas_estado_idx        ON ventas(tenant_id, branch_id, estado_venta_id);
CREATE INDEX ventas_repartidor_idx    ON ventas(id_repartidor_asignado) WHERE id_repartidor_asignado IS NOT NULL;
CREATE INDEX ventas_liquidacion_idx   ON ventas(fecha_liquidacion_utc) WHERE fecha_liquidacion_utc IS NOT NULL;

-- Índices para detalle
CREATE INDEX ventas_detalle_venta_idx     ON ventas_detalle(id_venta);
CREATE INDEX ventas_detalle_producto_idx  ON ventas_detalle(id_producto);

-- 6. TRIGGER PARA UPDATED_AT
CREATE TRIGGER update_ventas_updated_at
  BEFORE UPDATE ON ventas
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- 7. COMENTARIOS PARA DOCUMENTACIÓN
COMMENT ON TABLE ventas IS 'Tabla 1:1 con Desktop Venta.cs - Cabecera de ventas con timestamps raw';
COMMENT ON TABLE ventas_detalle IS 'Tabla 1:1 con Desktop VentaDetalle.cs - Líneas de venta';

COMMENT ON COLUMN ventas.fecha_venta_raw IS 'Timestamp raw desde Desktop (epoch_ms o .NET ticks)';
COMMENT ON COLUMN ventas.fecha_venta_utc IS 'Columna generada para queries - convierte fecha_venta_raw a timestamptz';
COMMENT ON COLUMN ventas.ticket_number IS 'Folio consecutivo dentro de la sucursal';
COMMENT ON COLUMN ventas.estado_venta_id IS '1=Borrador, 2=Asignada, 3=Completada, 4=Cancelada, 5=Liquidada';
COMMENT ON COLUMN ventas.venta_tipo_id IS '1=Mostrador, 2=Repartidor';

COMMENT ON COLUMN ventas_detalle.cantidad IS 'Cantidad con 3 decimales para productos que se pesan';
COMMENT ON COLUMN ventas_detalle.precio_lista IS 'Precio de lista antes de descuentos';
COMMENT ON COLUMN ventas_detalle.precio_unitario IS 'Precio final unitario después de descuentos';
COMMENT ON COLUMN ventas_detalle.total_linea IS 'Total de la línea (precio_unitario * cantidad)';
