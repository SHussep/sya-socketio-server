-- ═══════════════════════════════════════════════════════════════
-- FIX: Configurar PostgreSQL a UTC y corregir timestamps
-- ═══════════════════════════════════════════════════════════════
-- Este script configura la base de datos a UTC y recalcula los
-- timestamps de ventas que se guardaron con timezone incorrecto.
-- ═══════════════════════════════════════════════════════════════

-- 1. Configurar database a UTC
ALTER DATABASE sya_tortillerias SET timezone TO 'UTC';

-- 2. Reconectar para que los cambios surtan efecto
-- (Ejecutar \c sya_tortillerias en psql, o reconectar desde la app)

-- 3. Verificar configuración
SHOW timezone;  -- Debería mostrar 'UTC'

-- 4. Notas sobre timestamps existentes:
-- Los timestamps en PostgreSQL ya están guardados correctamente
-- (la columna es TIMESTAMPTZ que siempre guarda en UTC internamente).
-- El problema es solo de DISPLAY (+1100 vs +0000).
--
-- Después de cambiar timezone a UTC, todos los timestamps se mostrarán
-- correctamente con offset +0000.
--
-- NO ES NECESARIO actualizar los datos existentes.
