-- =====================================================
-- Migration: 042_create_repartidor_assignments_table.sql
-- Descripción: Crear tabla para asignaciones de repartidores
-- =====================================================
-- Esta tabla rastrea las asignaciones de productos a repartidores:
-- - Cuántos kilos se les asignaron
-- - Cuánto dinero recibieron
-- - Cuánto devolvieron
-- - Estado de la asignación (asignada, en_progreso, liquidada, etc.)
-- =====================================================

CREATE TABLE IF NOT EXISTS repartidor_assignments (
  id SERIAL PRIMARY KEY,

  -- Relaciones
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  turno_repartidor_id INTEGER REFERENCES shifts(id) ON DELETE SET NULL,

  -- Cantidades asignadas y devueltas
  cantidad_asignada NUMERIC(10, 2) NOT NULL DEFAULT 0,  -- Kilos asignados
  cantidad_devuelta NUMERIC(10, 2) NOT NULL DEFAULT 0,  -- Kilos devueltos

  -- Montos asignados y devueltos
  monto_asignado NUMERIC(10, 2) NOT NULL DEFAULT 0,     -- Dinero asignado (precio de los kilos)
  monto_devuelto NUMERIC(10, 2) NOT NULL DEFAULT 0,     -- Dinero devuelto

  -- Estado de la asignación
  estado VARCHAR(50) NOT NULL DEFAULT 'asignada',
  -- Valores posibles: 'asignada', 'en_progreso', 'liquidada', 'cancelada'

  -- Fechas importantes
  fecha_asignacion TIMESTAMP NOT NULL DEFAULT NOW(),
  fecha_devoluciones TIMESTAMP,                         -- Cuando devolvió producto
  fecha_liquidacion TIMESTAMP,                          -- Cuando se liquidó la asignación

  -- Observaciones
  observaciones TEXT,

  -- Campos de sincronización
  synced BOOLEAN NOT NULL DEFAULT true,                 -- Siempre true en backend
  remote_id INTEGER,                                    -- No usado en backend (para Desktop)
  synced_at TIMESTAMP,
  last_sync_error TEXT,

  -- Auditoría
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Índices para mejorar performance
CREATE INDEX IF NOT EXISTS idx_repartidor_assignments_tenant ON repartidor_assignments(tenant_id);
CREATE INDEX IF NOT EXISTS idx_repartidor_assignments_branch ON repartidor_assignments(branch_id);
CREATE INDEX IF NOT EXISTS idx_repartidor_assignments_sale ON repartidor_assignments(sale_id);
CREATE INDEX IF NOT EXISTS idx_repartidor_assignments_employee ON repartidor_assignments(employee_id);
CREATE INDEX IF NOT EXISTS idx_repartidor_assignments_turno ON repartidor_assignments(turno_repartidor_id);
CREATE INDEX IF NOT EXISTS idx_repartidor_assignments_estado ON repartidor_assignments(estado);
CREATE INDEX IF NOT EXISTS idx_repartidor_assignments_fecha_asignacion ON repartidor_assignments(fecha_asignacion);

-- Comentarios para documentación
COMMENT ON TABLE repartidor_assignments IS 'Asignaciones de productos/ventas a repartidores con tracking de cantidades y montos';
COMMENT ON COLUMN repartidor_assignments.cantidad_asignada IS 'Kilos de producto asignados al repartidor';
COMMENT ON COLUMN repartidor_assignments.cantidad_devuelta IS 'Kilos de producto devueltos por el repartidor';
COMMENT ON COLUMN repartidor_assignments.monto_asignado IS 'Valor monetario del producto asignado';
COMMENT ON COLUMN repartidor_assignments.monto_devuelto IS 'Valor monetario del producto devuelto';
COMMENT ON COLUMN repartidor_assignments.estado IS 'Estado de la asignación: asignada, en_progreso, liquidada, cancelada';
