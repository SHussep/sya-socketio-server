-- =====================================================
-- Migration: 044_simplify_sales_schema.sql
-- Descripción: Simplificar tabla sales y eliminar tabla redundante
-- =====================================================
-- Basado en el modelo Desktop Venta.cs:
-- - Eliminar sale_items (redundante con sales_items)
-- - Eliminar columnas innecesarias de sales
-- - Mantener solo campos que se manejan en Desktop
-- =====================================================

-- 1. ELIMINAR TABLA REDUNDANTE sale_items
-- (sales_items es la correcta, tiene tenant_id y branch_id)
DROP TABLE IF EXISTS sale_items CASCADE;

-- 2. ELIMINAR COLUMNAS INNECESARIAS DE sales
-- Estas columnas NO se usan en Desktop y solo complican el sync

-- Campos de tarjeta (no se manejan en Desktop)
ALTER TABLE sales DROP COLUMN IF EXISTS card_type CASCADE;
ALTER TABLE sales DROP COLUMN IF EXISTS card_last_four CASCADE;

-- Campos de cancelación (se maneja con sale_status)
ALTER TABLE sales DROP COLUMN IF EXISTS is_cancelled CASCADE;
ALTER TABLE sales DROP COLUMN IF EXISTS cancelled_at CASCADE;
ALTER TABLE sales DROP COLUMN IF EXISTS cancelled_by CASCADE;
ALTER TABLE sales DROP COLUMN IF EXISTS cancellation_reason CASCADE;

-- Campos de delivery (se maneja con sale_type_id)
ALTER TABLE sales DROP COLUMN IF EXISTS is_delivery CASCADE;
ALTER TABLE sales DROP COLUMN IF EXISTS delivery_address CASCADE;
ALTER TABLE sales DROP COLUMN IF EXISTS delivery_fee CASCADE;
ALTER TABLE sales DROP COLUMN IF EXISTS delivery_status CASCADE;
ALTER TABLE sales DROP COLUMN IF EXISTS delivery_person_id CASCADE; -- Usar IdRepartidorAsignado

-- Campos de cliente redundantes (ya existe customer_id)
ALTER TABLE sales DROP COLUMN IF EXISTS customer_name CASCADE;
ALTER TABLE sales DROP COLUMN IF EXISTS customer_phone CASCADE;

-- Campos de crédito (no se manejan)
ALTER TABLE sales DROP COLUMN IF EXISTS is_credit_sale CASCADE;
ALTER TABLE sales DROP COLUMN IF EXISTS credit_due_date CASCADE;

-- Campos de impresión de recibo (no necesarios en backend)
ALTER TABLE sales DROP COLUMN IF EXISTS receipt_printed CASCADE;
ALTER TABLE sales DROP COLUMN IF EXISTS receipt_print_count CASCADE;

-- Campos de facturación (no implementados)
ALTER TABLE sales DROP COLUMN IF EXISTS folio_fiscal CASCADE;

-- Campos de numeración redundantes (ya existe ticket_number)
ALTER TABLE sales DROP COLUMN IF EXISTS branch_sale_number CASCADE;
ALTER TABLE sales DROP COLUMN IF EXISTS shift_sale_number CASCADE;

-- Campos de pago redundantes (payment_type_id ya existe)
ALTER TABLE sales DROP COLUMN IF EXISTS payment_type CASCADE;

-- Campos calculados redundantes (subtotal, discount, tax ya existen)
ALTER TABLE sales DROP COLUMN IF EXISTS cash_received CASCADE;
ALTER TABLE sales DROP COLUMN IF EXISTS change_given CASCADE;

-- synced_from_desktop_at redundante (usar synced_at)
ALTER TABLE sales DROP COLUMN IF EXISTS synced_from_desktop_at CASCADE;

-- 3. AGREGAR CAMPOS FALTANTES DEL MODELO DESKTOP

-- IdRepartidorAsignado (repartidor asignado)
ALTER TABLE sales ADD COLUMN IF NOT EXISTS id_repartidor_asignado INT REFERENCES employees(id) ON DELETE SET NULL;

-- IdTurnoRepartidor (turno del repartidor)
ALTER TABLE sales ADD COLUMN IF NOT EXISTS id_turno_repartidor INT REFERENCES shifts(id) ON DELETE SET NULL;

-- IdTurno (turno del cajero que crea la venta) - shift_id ya existe

-- FechaLiquidacion (fecha de liquidación para ventas de repartidor)
ALTER TABLE sales ADD COLUMN IF NOT EXISTS fecha_liquidacion TIMESTAMP;

-- MontoPagado (cantidad realmente cobrada)
ALTER TABLE sales ADD COLUMN IF NOT EXISTS monto_pagado NUMERIC(10, 2) DEFAULT 0;

-- EstadoVentaId (1=Borrador, 2=Asignada, 3=Completada, 4=Cancelada, 5=Liquidada)
-- sale_status ya existe pero necesitamos asegurar que sea entero
ALTER TABLE sales ADD COLUMN IF NOT EXISTS estado_venta_id INT DEFAULT 3;

-- 4. RENOMBRAR COLUMNAS PARA COINCIDIR CON DESKTOP (snake_case)
-- Esto hace más fácil el mapping en el código

COMMENT ON COLUMN sales.id IS 'ID primario - RemoteId en Desktop';
COMMENT ON COLUMN sales.tenant_id IS 'TenantId';
COMMENT ON COLUMN sales.branch_id IS 'BranchId';
COMMENT ON COLUMN sales.employee_id IS 'IdEmpleado';
COMMENT ON COLUMN sales.customer_id IS 'IdCliente';
COMMENT ON COLUMN sales.ticket_number IS 'TicketNumber';
COMMENT ON COLUMN sales.total_amount IS 'Total';
COMMENT ON COLUMN sales.subtotal IS 'Subtotal';
COMMENT ON COLUMN sales.discount_amount IS 'TotalDescuentos';
COMMENT ON COLUMN sales.payment_method IS 'Método de pago en texto';
COMMENT ON COLUMN sales.payment_type_id IS 'TipoPagoId';
COMMENT ON COLUMN sales.sale_type IS 'Tipo de venta en texto';
COMMENT ON COLUMN sales.sale_type_id IS 'VentaTipoId (1=Mostrador, 2=Repartidor)';
COMMENT ON COLUMN sales.sale_status IS 'Estado de la venta en texto';
COMMENT ON COLUMN sales.estado_venta_id IS 'EstadoVentaId (1=Borrador, 2=Asignada, 3=Completada, 4=Cancelada, 5=Liquidada)';
COMMENT ON COLUMN sales.notes IS 'Notas';
COMMENT ON COLUMN sales.sale_date IS 'FechaVenta';
COMMENT ON COLUMN sales.shift_id IS 'IdTurno (turno del cajero)';
COMMENT ON COLUMN sales.id_repartidor_asignado IS 'IdRepartidorAsignado';
COMMENT ON COLUMN sales.id_turno_repartidor IS 'IdTurnoRepartidor';
COMMENT ON COLUMN sales.fecha_liquidacion IS 'FechaLiquidacion';
COMMENT ON COLUMN sales.monto_pagado IS 'MontoPagado';

-- 5. CREAR ÍNDICES PARA CAMPOS NUEVOS
CREATE INDEX IF NOT EXISTS idx_sales_id_repartidor_asignado ON sales(id_repartidor_asignado);
CREATE INDEX IF NOT EXISTS idx_sales_id_turno_repartidor ON sales(id_turno_repartidor);
CREATE INDEX IF NOT EXISTS idx_sales_estado_venta_id ON sales(estado_venta_id);
CREATE INDEX IF NOT EXISTS idx_sales_fecha_liquidacion ON sales(fecha_liquidacion) WHERE fecha_liquidacion IS NOT NULL;
