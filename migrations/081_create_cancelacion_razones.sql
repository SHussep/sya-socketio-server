-- =====================================================
-- Migration 081: Create cancelacion_razones table with normalized cancellation reasons
-- Purpose: Provide structured, pre-defined cancellation reasons for data analysis
-- Author: System
-- Date: 2025-01-09
-- =====================================================

-- Create cancelacion_razones table (master data)
CREATE TABLE IF NOT EXISTS cancelacion_razones (
    id SERIAL PRIMARY KEY,
    descripcion VARCHAR(200) NOT NULL UNIQUE,
    requiere_otra_razon BOOLEAN DEFAULT FALSE, -- True if this is "Otra" and requires additional text
    activo BOOLEAN DEFAULT TRUE, -- Allows soft-delete without removing records
    orden INTEGER NOT NULL DEFAULT 0, -- Display order in UI
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Create index for active reasons ordered by display order
CREATE INDEX IF NOT EXISTS idx_cancelacion_razones_activo_orden ON cancelacion_razones(activo, orden) WHERE activo = TRUE;

-- Seed common cancellation reasons (in Spanish for tortillería context)
INSERT INTO cancelacion_razones (descripcion, requiere_otra_razon, activo, orden) VALUES
('El cliente se fue sin esperar', FALSE, TRUE, 1),
('El cliente cambió de opinión', FALSE, TRUE, 2),
('Peso incorrecto - producto muy pesado', FALSE, TRUE, 3),
('Peso incorrecto - producto muy ligero', FALSE, TRUE, 4),
('Producto agotado', FALSE, TRUE, 5),
('Seleccioné el producto equivocado', FALSE, TRUE, 6),
('Error en el precio', FALSE, TRUE, 7),
('Cliente no tenía dinero suficiente', FALSE, TRUE, 8),
('Problema con el método de pago', FALSE, TRUE, 9),
('Producto en mal estado', FALSE, TRUE, 10),
('Cliente pidió cambio de producto', FALSE, TRUE, 11),
('Error de captura del empleado', FALSE, TRUE, 12),
('Duplicado - ya se registró', FALSE, TRUE, 13),
('Otra', TRUE, TRUE, 99); -- ALWAYS LAST - requires otra_razon text

-- Add comment to table
COMMENT ON TABLE cancelacion_razones IS 'Normalized cancellation reasons for sales and products - provides structured data for analysis';
COMMENT ON COLUMN cancelacion_razones.requiere_otra_razon IS 'If TRUE, cancellation must include otra_razon text field explaining the reason';
COMMENT ON COLUMN cancelacion_razones.activo IS 'Soft delete flag - allows hiding reasons without losing historical data';
COMMENT ON COLUMN cancelacion_razones.orden IS 'Display order in UI (lower = shown first, 99 = last)';
