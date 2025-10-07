// ═══════════════════════════════════════════════════════════════
// DATABASE CONNECTION - PostgreSQL
// ═══════════════════════════════════════════════════════════════

const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Test connection
pool.on('connect', () => {
    console.log('✅ Connected to PostgreSQL database');
});

pool.on('error', (err) => {
    console.error('❌ Unexpected error on idle client', err);
    process.exit(-1);
});

// Initialize database tables
async function initializeDatabase() {
    const client = await pool.connect();
    try {
        console.log('[DB] Initializing database schema...');

        // Tabla: tenants
        await client.query(`
            CREATE TABLE IF NOT EXISTS tenants (
                id SERIAL PRIMARY KEY,
                tenant_code VARCHAR(20) UNIQUE NOT NULL,
                business_name VARCHAR(255) NOT NULL,
                email VARCHAR(255) UNIQUE NOT NULL,
                phone_number VARCHAR(20),
                address TEXT,
                subscription_status VARCHAR(50) DEFAULT 'trial',
                subscription_plan VARCHAR(50) DEFAULT 'basic',
                subscription_ends_at TIMESTAMP,
                trial_ends_at TIMESTAMP,
                max_devices INTEGER DEFAULT 3,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Tabla: employees
        await client.query(`
            CREATE TABLE IF NOT EXISTS employees (
                id SERIAL PRIMARY KEY,
                tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
                username VARCHAR(100) NOT NULL,
                full_name VARCHAR(255) NOT NULL,
                email VARCHAR(255) NOT NULL,
                password VARCHAR(255) NOT NULL,
                role VARCHAR(50) DEFAULT 'employee',
                is_active BOOLEAN DEFAULT true,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(tenant_id, username),
                UNIQUE(tenant_id, email)
            )
        `);

        // Tabla: devices
        await client.query(`
            CREATE TABLE IF NOT EXISTS devices (
                id VARCHAR(255) PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
                employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
                device_type VARCHAR(50) DEFAULT 'mobile',
                platform VARCHAR(50),
                last_active TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                linked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                is_active BOOLEAN DEFAULT true
            )
        `);

        // Tabla: sessions
        await client.query(`
            CREATE TABLE IF NOT EXISTS sessions (
                id SERIAL PRIMARY KEY,
                tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
                employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
                device_id VARCHAR(255) REFERENCES devices(id) ON DELETE CASCADE,
                access_token TEXT NOT NULL,
                refresh_token TEXT NOT NULL,
                expires_at TIMESTAMP NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                is_active BOOLEAN DEFAULT true
            )
        `);

        // Tabla: branches (sucursales)
        await client.query(`
            CREATE TABLE IF NOT EXISTS branches (
                id SERIAL PRIMARY KEY,
                tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
                branch_code VARCHAR(20) NOT NULL,
                name VARCHAR(255) NOT NULL,
                address TEXT,
                phone_number VARCHAR(20),
                is_active BOOLEAN DEFAULT true,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(tenant_id, branch_code)
            )
        `);

        // Tabla: sales (ventas - resumen para móvil)
        await client.query(`
            CREATE TABLE IF NOT EXISTS sales (
                id SERIAL PRIMARY KEY,
                tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
                branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
                employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
                ticket_number VARCHAR(50) NOT NULL,
                total_amount DECIMAL(10, 2) NOT NULL,
                payment_method VARCHAR(50),
                sale_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(tenant_id, ticket_number)
            )
        `);

        // Tabla: expenses (gastos)
        await client.query(`
            CREATE TABLE IF NOT EXISTS expenses (
                id SERIAL PRIMARY KEY,
                tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
                branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
                employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
                category VARCHAR(100) NOT NULL,
                description TEXT,
                amount DECIMAL(10, 2) NOT NULL,
                expense_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Tabla: cash_cuts (cortes de caja)
        await client.query(`
            CREATE TABLE IF NOT EXISTS cash_cuts (
                id SERIAL PRIMARY KEY,
                tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
                branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
                employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
                cut_number VARCHAR(50) NOT NULL,
                total_sales DECIMAL(10, 2) NOT NULL,
                total_expenses DECIMAL(10, 2) NOT NULL,
                cash_in_drawer DECIMAL(10, 2) NOT NULL,
                expected_cash DECIMAL(10, 2) NOT NULL,
                difference DECIMAL(10, 2) DEFAULT 0,
                cut_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(tenant_id, cut_number)
            )
        `);

        // Tabla: guardian_events (eventos del modo guardián - MUY IMPORTANTE)
        await client.query(`
            CREATE TABLE IF NOT EXISTS guardian_events (
                id SERIAL PRIMARY KEY,
                tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
                branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
                employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
                event_type VARCHAR(50) NOT NULL,
                severity VARCHAR(20) DEFAULT 'medium',
                title VARCHAR(255) NOT NULL,
                description TEXT,
                weight_kg DECIMAL(8, 3),
                scale_id VARCHAR(100),
                metadata JSONB,
                is_read BOOLEAN DEFAULT false,
                event_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Índices
        await client.query('CREATE INDEX IF NOT EXISTS idx_employees_tenant_id ON employees(tenant_id)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_employees_email ON employees(email)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_devices_tenant_id ON devices(tenant_id)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_sessions_tenant_id ON sessions(tenant_id)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_branches_tenant_id ON branches(tenant_id)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_sales_tenant_id ON sales(tenant_id)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_sales_branch_id ON sales(branch_id)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_sales_date ON sales(sale_date DESC)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_expenses_tenant_id ON expenses(tenant_id)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_expenses_branch_id ON expenses(branch_id)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(expense_date DESC)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_cash_cuts_tenant_id ON cash_cuts(tenant_id)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_cash_cuts_branch_id ON cash_cuts(branch_id)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_guardian_events_tenant_id ON guardian_events(tenant_id)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_guardian_events_branch_id ON guardian_events(branch_id)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_guardian_events_date ON guardian_events(event_date DESC)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_guardian_events_unread ON guardian_events(tenant_id, is_read) WHERE is_read = false');

        console.log('[DB] ✅ Database schema initialized successfully');
    } catch (error) {
        console.error('[DB] ❌ Error initializing database:', error);
        throw error;
    } finally {
        client.release();
    }
}

module.exports = {
    pool,
    initializeDatabase
};
