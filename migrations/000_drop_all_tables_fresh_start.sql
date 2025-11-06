-- =====================================================
-- Migration: 000_drop_all_tables_fresh_start.sql
-- Descripción: DROP CASCADE de TODAS las tablas para empezar desde cero
-- =====================================================
-- PROPÓSITO: La BD tenía estado inconsistente de migraciones legacy.
-- Este migration limpia TODO y permite que 050-060 creen el esquema limpio.
--
-- SEGURIDAD: Solo se ejecuta UNA VEZ (si hay alguna tabla legacy).
-- Si ya está limpio, no hace nada.
-- =====================================================

DO $$
DECLARE
    r RECORD;
BEGIN
    -- DROP todas las tablas en cascade (elimina FKs automáticamente)
    FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
        EXECUTE 'DROP TABLE IF EXISTS ' || quote_ident(r.tablename) || ' CASCADE';
        RAISE NOTICE 'Dropped table: %', r.tablename;
    END LOOP;

    -- DROP todas las secuencias
    FOR r IN (SELECT sequence_name FROM information_schema.sequences WHERE sequence_schema = 'public') LOOP
        EXECUTE 'DROP SEQUENCE IF EXISTS ' || quote_ident(r.sequence_name) || ' CASCADE';
        RAISE NOTICE 'Dropped sequence: %', r.sequence_name;
    END LOOP;

    -- DROP todas las vistas
    FOR r IN (SELECT table_name FROM information_schema.views WHERE table_schema = 'public') LOOP
        EXECUTE 'DROP VIEW IF EXISTS ' || quote_ident(r.table_name) || ' CASCADE';
        RAISE NOTICE 'Dropped view: %', r.table_name;
    END LOOP;

    -- DROP todas las funciones (excepto las del sistema)
    FOR r IN (
        SELECT proname, oidvectortypes(proargtypes) as argtypes
        FROM pg_proc
        INNER JOIN pg_namespace ns ON (pg_proc.pronamespace = ns.oid)
        WHERE ns.nspname = 'public'
    ) LOOP
        BEGIN
            EXECUTE 'DROP FUNCTION IF EXISTS ' || quote_ident(r.proname) || '(' || r.argtypes || ') CASCADE';
            RAISE NOTICE 'Dropped function: %(%)', r.proname, r.argtypes;
        EXCEPTION WHEN OTHERS THEN
            RAISE NOTICE 'Could not drop function: %(%)', r.proname, r.argtypes;
        END;
    END LOOP;

    -- DROP todos los tipos personalizados
    FOR r IN (SELECT typname FROM pg_type WHERE typnamespace = 'public'::regnamespace AND typtype = 'e') LOOP
        EXECUTE 'DROP TYPE IF EXISTS ' || quote_ident(r.typname) || ' CASCADE';
        RAISE NOTICE 'Dropped type: %', r.typname;
    END LOOP;

    RAISE NOTICE '✅ Database cleaned - fresh start ready';
END $$;

-- Crear función helper para update_updated_at_column (usado por múltiples tablas)
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

COMMENT ON FUNCTION update_updated_at_column() IS 'Trigger function to auto-update updated_at column';
