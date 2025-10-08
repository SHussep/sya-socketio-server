-- Migración 005: Agregar columnas faltantes a tenants
-- Fecha: 2025-10-07
-- Propósito: Agregar columnas necesarias para autenticación multi-tenant

-- Agregar tenant_code
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS tenant_code VARCHAR(20) UNIQUE;

-- Agregar email (renombrando owner_email si existe)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'tenants' AND column_name = 'email') THEN
        -- Si existe owner_email, renombrarla
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'tenants' AND column_name = 'owner_email') THEN
            ALTER TABLE tenants RENAME COLUMN owner_email TO email;
        ELSE
            ALTER TABLE tenants ADD COLUMN email VARCHAR(255) UNIQUE NOT NULL;
        END IF;
    END IF;
END $$;

-- Renombrar phone a phone_number
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'tenants' AND column_name = 'phone') THEN
        ALTER TABLE tenants RENAME COLUMN phone TO phone_number;
    ELSE
        ALTER TABLE tenants ADD COLUMN IF NOT EXISTS phone_number VARCHAR(20);
    END IF;
END $$;

-- Agregar columnas de subscription
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS subscription_status VARCHAR(50) DEFAULT 'trial';
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS subscription_plan VARCHAR(50) DEFAULT 'basic';
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS subscription_ends_at TIMESTAMP;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMP;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS max_devices INTEGER DEFAULT 3;

-- Generar tenant_code para registros existentes que no lo tienen
UPDATE tenants SET tenant_code = 'SYA' || LPAD(id::TEXT, 6, '0') WHERE tenant_code IS NULL;

-- Verificar estructura final
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'tenants'
ORDER BY ordinal_position;
