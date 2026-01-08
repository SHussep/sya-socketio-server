-- ═══════════════════════════════════════════════════════════════════════════
-- MIGRACIÓN: Notas de Crédito (Devoluciones)
-- ═══════════════════════════════════════════════════════════════════════════
-- Las Notas de Crédito permiten ajustar/cancelar ventas de turnos cerrados
-- sin modificar los registros originales, manteniendo auditoría completa.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Agregar campo has_nota_credito a ventas
ALTER TABLE ventas
ADD COLUMN IF NOT EXISTS has_nota_credito BOOLEAN DEFAULT FALSE;

-- 2. Crear tabla notas_credito
CREATE TABLE IF NOT EXISTS notas_credito (
    id SERIAL PRIMARY KEY,

    -- Referencias
    venta_original_id INTEGER NOT NULL REFERENCES ventas(id_venta),
    shift_id INTEGER NOT NULL REFERENCES shifts(id),
    employee_id INTEGER NOT NULL REFERENCES employees(id),
    authorized_by_id INTEGER NOT NULL REFERENCES employees(id),
    cliente_id INTEGER REFERENCES customers(id),
    tenant_id INTEGER NOT NULL REFERENCES tenants(id),
    branch_id INTEGER NOT NULL REFERENCES branches(id),

    -- Tipo y Estado
    tipo VARCHAR(50) NOT NULL DEFAULT 'Cancelacion', -- Cancelacion, Devolucion, Ajuste
    estado VARCHAR(50) NOT NULL DEFAULT 'Aplicada',  -- Pendiente, Aplicada, Anulada

    -- Montos
    total DECIMAL(12,2) NOT NULL,
    monto_credito DECIMAL(12,2) DEFAULT 0,
    monto_efectivo DECIMAL(12,2) DEFAULT 0,
    monto_tarjeta DECIMAL(12,2) DEFAULT 0,

    -- Fechas
    fecha_creacion TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    fecha_venta_original TIMESTAMP WITH TIME ZONE,

    -- Razón y Notas
    razon VARCHAR(500) NOT NULL,
    notas TEXT,

    -- Números de referencia
    numero_nota_credito VARCHAR(50),
    ticket_original INTEGER,

    -- Sincronización offline-first
    global_id VARCHAR(36) NOT NULL UNIQUE,
    terminal_id VARCHAR(50),
    local_op_seq INTEGER DEFAULT 0,
    device_event_raw BIGINT DEFAULT 0,
    created_local_utc TIMESTAMP WITH TIME ZONE,

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 3. Crear tabla notas_credito_detalle
CREATE TABLE IF NOT EXISTS notas_credito_detalle (
    id SERIAL PRIMARY KEY,

    -- Referencias
    nota_credito_id INTEGER NOT NULL REFERENCES notas_credito(id) ON DELETE CASCADE,
    venta_detalle_original_id INTEGER REFERENCES ventas_detalle(id_venta_detalle),
    producto_id INTEGER NOT NULL REFERENCES productos(id),

    -- Datos del producto (copiados para historial)
    descripcion_producto VARCHAR(255) NOT NULL,
    cantidad DECIMAL(12,3) NOT NULL,
    cantidad_original DECIMAL(12,3) DEFAULT 0,
    precio_unitario DECIMAL(12,2) NOT NULL,
    total_linea DECIMAL(12,2) NOT NULL,

    -- Inventario
    devuelve_a_inventario BOOLEAN DEFAULT TRUE,
    kardex_movimiento_id INTEGER,

    -- Sincronización offline-first
    global_id VARCHAR(36) NOT NULL UNIQUE,
    terminal_id VARCHAR(50),
    local_op_seq INTEGER DEFAULT 0,

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 4. Índices para rendimiento
CREATE INDEX IF NOT EXISTS idx_notas_credito_tenant ON notas_credito(tenant_id);
CREATE INDEX IF NOT EXISTS idx_notas_credito_branch ON notas_credito(branch_id);
CREATE INDEX IF NOT EXISTS idx_notas_credito_venta ON notas_credito(venta_original_id);
CREATE INDEX IF NOT EXISTS idx_notas_credito_shift ON notas_credito(shift_id);
CREATE INDEX IF NOT EXISTS idx_notas_credito_estado ON notas_credito(estado);
CREATE INDEX IF NOT EXISTS idx_notas_credito_fecha ON notas_credito(fecha_creacion);
CREATE INDEX IF NOT EXISTS idx_notas_credito_updated ON notas_credito(updated_at);

CREATE INDEX IF NOT EXISTS idx_notas_credito_detalle_nc ON notas_credito_detalle(nota_credito_id);
CREATE INDEX IF NOT EXISTS idx_notas_credito_detalle_producto ON notas_credito_detalle(producto_id);

-- 5. Trigger para actualizar updated_at
CREATE OR REPLACE FUNCTION update_notas_credito_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_notas_credito_updated_at ON notas_credito;
CREATE TRIGGER trigger_notas_credito_updated_at
    BEFORE UPDATE ON notas_credito
    FOR EACH ROW
    EXECUTE FUNCTION update_notas_credito_updated_at();

-- 6. Trigger para marcar venta con has_nota_credito
CREATE OR REPLACE FUNCTION update_venta_has_nota_credito()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.estado = 'Aplicada' THEN
        UPDATE ventas
        SET has_nota_credito = TRUE, updated_at = CURRENT_TIMESTAMP
        WHERE id_venta = NEW.venta_original_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_venta_has_nota_credito ON notas_credito;
CREATE TRIGGER trigger_venta_has_nota_credito
    AFTER INSERT OR UPDATE ON notas_credito
    FOR EACH ROW
    EXECUTE FUNCTION update_venta_has_nota_credito();

COMMENT ON TABLE notas_credito IS 'Notas de crédito para devoluciones/cancelaciones de ventas';
COMMENT ON TABLE notas_credito_detalle IS 'Detalle de productos en notas de crédito';
COMMENT ON COLUMN ventas.has_nota_credito IS 'Indica si la venta tiene notas de crédito aplicadas';
