-- =====================================================
-- Migration: 002_create_ventas_and_related.sql
-- Descripción: Crear tablas ventas, repartidor_assignments y roles
-- =====================================================
-- Estas tablas son creadas por migraciones legacy (042, 046)
-- pero fallan por dependencias. Las creamos aquí en orden correcto.
-- =====================================================

-- ========== TABLA: roles (sistema de roles globales) ==========
CREATE TABLE IF NOT EXISTS roles (
    id INTEGER PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE,
    description TEXT,
    permissions JSONB,
    is_system BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Insertar roles globales fijos
INSERT INTO roles (id, name, description, is_system)
VALUES
    (1, 'Administrador', 'Acceso completo al sistema', true),
    (2, 'Encargado', 'Gestión de sucursal y empleados', true),
    (3, 'Repartidor', 'Repartidor con acceso móvil', true),
    (4, 'Ayudante', 'Ayudante general', true),
    (99, 'Otro', 'Rol personalizado', true)
ON CONFLICT (id) DO NOTHING;

-- ========== TABLA: ventas (cabecera de ventas) ==========
CREATE TABLE IF NOT EXISTS ventas (
    id_venta INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    -- Scope
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,

    -- Estado y asignaciones
    estado_venta_id INTEGER NOT NULL DEFAULT 3,
    id_repartidor_asignado INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    id_turno_repartidor INTEGER REFERENCES shifts(id) ON DELETE SET NULL,
    id_turno INTEGER NOT NULL REFERENCES shifts(id) ON DELETE RESTRICT,

    -- Relaciones
    id_empleado INTEGER NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
    id_cliente INTEGER, -- FK a customers (se agrega después)
    venta_tipo_id INTEGER,
    tipo_pago_id INTEGER,

    -- Folio visible
    ticket_number INTEGER NOT NULL,

    -- Timestamps RAW
    fecha_venta_raw BIGINT,
    fecha_liquidacion_raw BIGINT,

    -- Montos
    subtotal NUMERIC(14,2) DEFAULT 0,
    total_descuentos NUMERIC(14,2) DEFAULT 0,
    total NUMERIC(14,2) NOT NULL,
    monto_pagado NUMERIC(14,2) DEFAULT 0,

    -- Notas
    notas TEXT,

    -- Sincronización (parcial, se completa en 055)
    remote_id INTEGER,
    synced BOOLEAN NOT NULL DEFAULT TRUE,
    synced_at_raw BIGINT,

    -- Columnas generadas
    fecha_venta_utc TIMESTAMPTZ GENERATED ALWAYS AS
        (CASE
            WHEN fecha_venta_raw IS NULL THEN NULL
            ELSE to_timestamp((fecha_venta_raw)::double precision / 1000.0)
        END) STORED,

    fecha_liquidacion_utc TIMESTAMPTZ GENERATED ALWAYS AS
        (CASE
            WHEN fecha_liquidacion_raw IS NULL THEN NULL
            ELSE to_timestamp((fecha_liquidacion_raw)::double precision / 1000.0)
        END) STORED,

    synced_at_utc TIMESTAMPTZ GENERATED ALWAYS AS
        (CASE
            WHEN synced_at_raw IS NULL THEN NULL
            ELSE to_timestamp((synced_at_raw)::double precision / 1000.0)
        END) STORED,

    -- Auditoría
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ========== TABLA: ventas_detalle (líneas de venta) ==========
CREATE TABLE IF NOT EXISTS ventas_detalle (
    id_venta_detalle INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    -- FK a venta
    id_venta INTEGER NOT NULL REFERENCES ventas(id_venta) ON DELETE CASCADE,

    -- Producto
    id_producto INTEGER NOT NULL,
    descripcion_producto VARCHAR(255) NOT NULL,

    -- Cantidades y precios
    cantidad NUMERIC(14,3) NOT NULL,
    precio_lista NUMERIC(14,2) NOT NULL,
    precio_unitario NUMERIC(14,2) NOT NULL,
    total_linea NUMERIC(14,2) NOT NULL,

    -- Descuentos
    tipo_descuento_cliente_id INTEGER,
    monto_cliente_descuento NUMERIC(14,2) DEFAULT 0,
    tipo_descuento_manual_id INTEGER,
    monto_manual_descuento NUMERIC(14,2) DEFAULT 0,

    -- Auditoría
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ========== TABLA: repartidor_assignments (asignaciones de repartidores) ==========
CREATE TABLE IF NOT EXISTS repartidor_assignments (
    id SERIAL PRIMARY KEY,

    -- Relaciones
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    venta_id INTEGER NOT NULL REFERENCES ventas(id_venta) ON DELETE CASCADE,
    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    turno_repartidor_id INTEGER REFERENCES shifts(id) ON DELETE SET NULL,

    -- Cantidades
    cantidad_asignada NUMERIC(10, 2) NOT NULL DEFAULT 0,
    cantidad_devuelta NUMERIC(10, 2) NOT NULL DEFAULT 0,

    -- Montos
    monto_asignado NUMERIC(10, 2) NOT NULL DEFAULT 0,
    monto_devuelto NUMERIC(10, 2) NOT NULL DEFAULT 0,

    -- Estado
    estado VARCHAR(50) NOT NULL DEFAULT 'asignada',

    -- Fechas
    fecha_asignacion TIMESTAMP NOT NULL DEFAULT NOW(),
    fecha_devoluciones TIMESTAMP,
    fecha_liquidacion TIMESTAMP,

    -- Observaciones
    observaciones TEXT,

    -- Sincronización
    synced BOOLEAN NOT NULL DEFAULT TRUE,
    remote_id INTEGER,
    synced_at TIMESTAMP,
    last_sync_error TEXT,

    -- Auditoría
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ========== ÍNDICES ==========

-- ventas
CREATE UNIQUE INDEX IF NOT EXISTS ventas_uq_ticket_per_branch
    ON ventas(tenant_id, branch_id, ticket_number);

CREATE INDEX IF NOT EXISTS ventas_scope_time_idx ON ventas(tenant_id, branch_id, fecha_venta_utc DESC);
CREATE INDEX IF NOT EXISTS ventas_scope_turno_idx ON ventas(tenant_id, branch_id, id_turno);
CREATE INDEX IF NOT EXISTS ventas_scope_emp_idx ON ventas(tenant_id, branch_id, id_empleado);

-- ventas_detalle
CREATE INDEX IF NOT EXISTS ventas_detalle_venta_idx ON ventas_detalle(id_venta);
CREATE INDEX IF NOT EXISTS ventas_detalle_producto_idx ON ventas_detalle(id_producto);

-- repartidor_assignments
CREATE INDEX IF NOT EXISTS idx_repartidor_assignments_tenant ON repartidor_assignments(tenant_id);
CREATE INDEX IF NOT EXISTS idx_repartidor_assignments_branch ON repartidor_assignments(branch_id);
CREATE INDEX IF NOT EXISTS idx_repartidor_assignments_venta ON repartidor_assignments(venta_id);
CREATE INDEX IF NOT EXISTS idx_repartidor_assignments_employee ON repartidor_assignments(employee_id);
CREATE INDEX IF NOT EXISTS idx_repartidor_assignments_estado ON repartidor_assignments(estado);

-- ========== COMENTARIOS ==========
COMMENT ON TABLE roles IS 'Sistema de roles globales (IDs fijos 1-4, 99)';
COMMENT ON TABLE ventas IS 'Tabla 1:1 con Desktop Venta.cs - Cabecera de ventas';
COMMENT ON TABLE ventas_detalle IS 'Tabla 1:1 con Desktop VentaDetalle.cs - Líneas de venta';
COMMENT ON TABLE repartidor_assignments IS 'Asignaciones de ventas a repartidores';

-- Log de finalización
DO $$
BEGIN
    RAISE NOTICE '✅ Migration 002 completada: ventas, ventas_detalle, repartidor_assignments, roles creadas';
END $$;
