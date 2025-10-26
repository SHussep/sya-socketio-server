// ═══════════════════════════════════════════════════════════════
// MIGRATION 023: Create Cash Management Tables
// ═══════════════════════════════════════════════════════════════
//
// Creates comprehensive cash management system:
// - deposits: Money added to cash drawer
// - withdrawals: Money taken from cash drawer
// - cash_cuts: Complete cash cut session with all calculations

module.exports = {
    name: '023_create_cash_management_tables',
    async up(client) {
        console.log('🔄 Executing migration 023: Creating cash management tables...');

        try {
            // ═══════════════════════════════════════════════════════════════
            // TABLE 1: DEPOSITS (Dinero que entra a caja)
            // ═══════════════════════════════════════════════════════════════
            await client.query(`
                CREATE TABLE IF NOT EXISTS deposits (
                    id SERIAL PRIMARY KEY,
                    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
                    branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
                    shift_id INTEGER REFERENCES shifts(id) ON DELETE SET NULL,
                    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE SET NULL,

                    -- Deposit details
                    amount DECIMAL(12, 2) NOT NULL CHECK (amount > 0),
                    description TEXT,
                    deposit_type VARCHAR(50) DEFAULT 'manual', -- manual, bank_deposit, refund, etc

                    -- Metadata
                    deposit_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

                    -- Indexing
                    CONSTRAINT deposits_tenant_branch_idx UNIQUE (tenant_id, branch_id, id)
                );

                CREATE INDEX IF NOT EXISTS idx_deposits_tenant ON deposits(tenant_id);
                CREATE INDEX IF NOT EXISTS idx_deposits_branch ON deposits(branch_id);
                CREATE INDEX IF NOT EXISTS idx_deposits_shift ON deposits(shift_id);
                CREATE INDEX IF NOT EXISTS idx_deposits_employee ON deposits(employee_id);
                CREATE INDEX IF NOT EXISTS idx_deposits_date ON deposits(deposit_date DESC);
            `);
            console.log('✅ deposits table created');

            // ═══════════════════════════════════════════════════════════════
            // TABLE 2: WITHDRAWALS (Dinero que sale de caja)
            // ═══════════════════════════════════════════════════════════════
            await client.query(`
                CREATE TABLE IF NOT EXISTS withdrawals (
                    id SERIAL PRIMARY KEY,
                    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
                    branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
                    shift_id INTEGER REFERENCES shifts(id) ON DELETE SET NULL,
                    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE SET NULL,

                    -- Withdrawal details
                    amount DECIMAL(12, 2) NOT NULL CHECK (amount > 0),
                    description TEXT,
                    withdrawal_type VARCHAR(50) DEFAULT 'manual', -- manual, bank_deposit, loan, etc

                    -- Metadata
                    withdrawal_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

                    -- Indexing
                    CONSTRAINT withdrawals_tenant_branch_idx UNIQUE (tenant_id, branch_id, id)
                );

                CREATE INDEX IF NOT EXISTS idx_withdrawals_tenant ON withdrawals(tenant_id);
                CREATE INDEX IF NOT EXISTS idx_withdrawals_branch ON withdrawals(branch_id);
                CREATE INDEX IF NOT EXISTS idx_withdrawals_shift ON withdrawals(shift_id);
                CREATE INDEX IF NOT EXISTS idx_withdrawals_employee ON withdrawals(employee_id);
                CREATE INDEX IF NOT EXISTS idx_withdrawals_date ON withdrawals(withdrawal_date DESC);
            `);
            console.log('✅ withdrawals table created');

            // ═══════════════════════════════════════════════════════════════
            // TABLE 3: CASH CUTS (Corte de caja completo)
            // ═══════════════════════════════════════════════════════════════
            await client.query(`
                CREATE TABLE IF NOT EXISTS cash_cuts (
                    id SERIAL PRIMARY KEY,
                    tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
                    branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
                    shift_id INTEGER NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
                    employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE SET NULL,

                    -- Timing
                    start_time TIMESTAMP NOT NULL,
                    end_time TIMESTAMP NOT NULL,

                    -- Initial State
                    initial_amount DECIMAL(12, 2) NOT NULL DEFAULT 0,

                    -- Sales Breakdown
                    total_cash_sales DECIMAL(12, 2) DEFAULT 0,      -- Ventas en efectivo
                    total_card_sales DECIMAL(12, 2) DEFAULT 0,      -- Ventas con tarjeta
                    total_credit_sales DECIMAL(12, 2) DEFAULT 0,    -- Ventas a crédito

                    -- Payments Breakdown
                    total_cash_payments DECIMAL(12, 2) DEFAULT 0,   -- Pagos en efectivo
                    total_card_payments DECIMAL(12, 2) DEFAULT 0,   -- Pagos con tarjeta

                    -- Adjustments
                    total_expenses DECIMAL(12, 2) DEFAULT 0,        -- Gastos
                    total_deposits DECIMAL(12, 2) DEFAULT 0,        -- Depósitos
                    total_withdrawals DECIMAL(12, 2) DEFAULT 0,     -- Retiros

                    -- Physical Count
                    expected_cash_in_drawer DECIMAL(12, 2) DEFAULT 0, -- Monto que DEBERÍA haber
                    counted_cash DECIMAL(12, 2) DEFAULT 0,            -- Dinero que el empleado contó

                    -- Difference
                    difference DECIMAL(12, 2) DEFAULT 0,            -- Diferencia (faltante/sobrante)

                    -- Events/Metrics
                    unregistered_weight_events INTEGER DEFAULT 0,
                    scale_connection_events INTEGER DEFAULT 0,
                    cancelled_sales INTEGER DEFAULT 0,

                    -- Notes
                    notes TEXT,
                    is_closed BOOLEAN DEFAULT false,

                    -- Sync metadata
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

                    -- Indexing
                    CONSTRAINT cash_cuts_tenant_branch_idx UNIQUE (tenant_id, branch_id, id)
                );

                CREATE INDEX IF NOT EXISTS idx_cash_cuts_tenant ON cash_cuts(tenant_id);
                CREATE INDEX IF NOT EXISTS idx_cash_cuts_branch ON cash_cuts(branch_id);
                CREATE INDEX IF NOT EXISTS idx_cash_cuts_shift ON cash_cuts(shift_id);
                CREATE INDEX IF NOT EXISTS idx_cash_cuts_employee ON cash_cuts(employee_id);
                CREATE INDEX IF NOT EXISTS idx_cash_cuts_start_time ON cash_cuts(start_time DESC);
                CREATE INDEX IF NOT EXISTS idx_cash_cuts_closed ON cash_cuts(is_closed);
            `);
            console.log('✅ cash_cuts table created');

            console.log('✅ Migración 023 completada: Cash management tables created successfully');
        } catch (error) {
            console.error('❌ Error in migration 023:', error.message);
            throw error;
        }
    }
};
