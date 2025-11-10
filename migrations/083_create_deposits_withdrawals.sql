-- =====================================================
-- Migration: 023_create_deposits_withdrawals.sql
-- Descripción: Crear tablas deposits y withdrawals para gestión de caja
-- =====================================================

-- ========== DEPOSITS TABLE ==========
CREATE TABLE IF NOT EXISTS deposits (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    shift_id INTEGER REFERENCES shifts(id) ON DELETE SET NULL,
    employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,

    amount NUMERIC(12, 2) NOT NULL CHECK (amount >= 0),
    deposit_type VARCHAR(50) NOT NULL DEFAULT 'manual',
    deposit_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Agregar columnas faltantes si no existen (para tablas ya creadas)
DO $$
BEGIN
    -- Agregar deposit_type si no existe
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'deposits' AND column_name = 'deposit_type'
    ) THEN
        ALTER TABLE deposits ADD COLUMN deposit_type VARCHAR(50) NOT NULL DEFAULT 'manual';
        RAISE NOTICE '✅ Columna deposit_type agregada a deposits';
    END IF;

    -- Agregar deposit_date si no existe
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'deposits' AND column_name = 'deposit_date'
    ) THEN
        ALTER TABLE deposits ADD COLUMN deposit_date TIMESTAMPTZ NOT NULL DEFAULT NOW();
        RAISE NOTICE '✅ Columna deposit_date agregada a deposits';
    END IF;

    -- Agregar description si no existe
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'deposits' AND column_name = 'description'
    ) THEN
        ALTER TABLE deposits ADD COLUMN description TEXT NOT NULL DEFAULT '';
        RAISE NOTICE '✅ Columna description agregada a deposits';
    END IF;
END $$;

-- Índices para deposits
CREATE INDEX IF NOT EXISTS idx_deposits_tenant_branch ON deposits(tenant_id, branch_id);
CREATE INDEX IF NOT EXISTS idx_deposits_shift ON deposits(shift_id);
CREATE INDEX IF NOT EXISTS idx_deposits_employee ON deposits(employee_id);
CREATE INDEX IF NOT EXISTS idx_deposits_date ON deposits(deposit_date);

-- Comentarios
COMMENT ON TABLE deposits IS 'Registro de depósitos/ingresos adicionales a la caja';
COMMENT ON COLUMN deposits.amount IS 'Monto del depósito';
COMMENT ON COLUMN deposits.description IS 'Descripción del depósito';
COMMENT ON COLUMN deposits.deposit_type IS 'Tipo de depósito: manual, automatic, etc';
COMMENT ON COLUMN deposits.deposit_date IS 'Fecha y hora del depósito';

-- ========== WITHDRAWALS TABLE ==========
CREATE TABLE IF NOT EXISTS withdrawals (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    shift_id INTEGER REFERENCES shifts(id) ON DELETE SET NULL,
    employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,

    amount NUMERIC(12, 2) NOT NULL CHECK (amount >= 0),
    withdrawal_type VARCHAR(50) NOT NULL DEFAULT 'manual',
    withdrawal_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Agregar columnas faltantes si no existen (para tablas ya creadas)
DO $$
BEGIN
    -- Agregar withdrawal_type si no existe
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'withdrawals' AND column_name = 'withdrawal_type'
    ) THEN
        ALTER TABLE withdrawals ADD COLUMN withdrawal_type VARCHAR(50) NOT NULL DEFAULT 'manual';
        RAISE NOTICE '✅ Columna withdrawal_type agregada a withdrawals';
    END IF;

    -- Agregar withdrawal_date si no existe
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'withdrawals' AND column_name = 'withdrawal_date'
    ) THEN
        ALTER TABLE withdrawals ADD COLUMN withdrawal_date TIMESTAMPTZ NOT NULL DEFAULT NOW();
        RAISE NOTICE '✅ Columna withdrawal_date agregada a withdrawals';
    END IF;

    -- Agregar description si no existe
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'withdrawals' AND column_name = 'description'
    ) THEN
        ALTER TABLE withdrawals ADD COLUMN description TEXT NOT NULL DEFAULT '';
        RAISE NOTICE '✅ Columna description agregada a withdrawals';
    END IF;
END $$;

-- Índices para withdrawals
CREATE INDEX IF NOT EXISTS idx_withdrawals_tenant_branch ON withdrawals(tenant_id, branch_id);
CREATE INDEX IF NOT EXISTS idx_withdrawals_shift ON withdrawals(shift_id);
CREATE INDEX IF NOT EXISTS idx_withdrawals_employee ON withdrawals(employee_id);
CREATE INDEX IF NOT EXISTS idx_withdrawals_date ON withdrawals(withdrawal_date);

-- Comentarios
COMMENT ON TABLE withdrawals IS 'Registro de retiros de efectivo de la caja';
COMMENT ON COLUMN withdrawals.amount IS 'Monto del retiro';
COMMENT ON COLUMN withdrawals.description IS 'Descripción del retiro';
COMMENT ON COLUMN withdrawals.withdrawal_type IS 'Tipo de retiro: manual, automatic, etc';
COMMENT ON COLUMN withdrawals.withdrawal_date IS 'Fecha y hora del retiro';
