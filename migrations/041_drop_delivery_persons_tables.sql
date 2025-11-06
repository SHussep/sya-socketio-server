-- =====================================================
-- Migration: 041_drop_delivery_persons_tables.sql
-- Descripción: Eliminar tablas redundantes de delivery persons
-- =====================================================
-- Las tablas delivery_persons y delivery_person_branches son redundantes
-- porque ya existe un sistema de empleados con roles.
-- Los repartidores son simplemente empleados con rol "repartidor".
-- =====================================================

-- Eliminar tablas relacionadas con delivery persons (si existen)
DROP TABLE IF EXISTS delivery_person_branches CASCADE;
DROP TABLE IF EXISTS delivery_persons CASCADE;

-- Nota: Las asignaciones de repartidor se manejarán en la tabla
-- repartidor_assignments que se creará en la siguiente migración.
