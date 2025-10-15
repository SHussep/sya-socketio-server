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

        // Tabla: subscriptions (planes de subscripción)
        await client.query(`
            CREATE TABLE IF NOT EXISTS subscriptions (
                id SERIAL PRIMARY KEY,
                name VARCHAR(50) UNIQUE NOT NULL,
                price DECIMAL(10, 2) NOT NULL,
                max_branches INTEGER DEFAULT 1,
                max_devices INTEGER DEFAULT 3,
                max_employees INTEGER DEFAULT 5,
                features JSONB,
                is_active BOOLEAN DEFAULT true,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Agregar columnas faltantes a tabla subscriptions existente
        try {
            await client.query(`ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS max_employees INTEGER DEFAULT 5`);
            console.log('[DB] ✅ Columna subscriptions.max_employees verificada/agregada');
        } catch (error) {
            console.log('[DB] ⚠️ subscriptions.max_employees:', error.message);
        }

        try {
            await client.query(`ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS features JSONB`);
            console.log('[DB] ✅ Columna subscriptions.features verificada/agregada');
        } catch (error) {
            console.log('[DB] ⚠️ subscriptions.features:', error.message);
        }

        try {
            await client.query(`ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true`);
            console.log('[DB] ✅ Columna subscriptions.is_active verificada/agregada');
        } catch (error) {
            console.log('[DB] ⚠️ subscriptions.is_active:', error.message);
        }

        // Insertar planes por defecto si no existen (solo con columnas que seguro existen)
        await client.query(`
            INSERT INTO subscriptions (name, price, max_branches, max_devices, max_employees, features)
            VALUES
                ('Basic', 0.00, 1, 3, 5, '{"guardian": true, "reports": true}'),
                ('Pro', 499.00, 3, 10, 20, '{"guardian": true, "reports": true, "advanced_analytics": true}'),
                ('Enterprise', 999.00, 10, 50, 100, '{"guardian": true, "reports": true, "advanced_analytics": true, "custom_features": true}')
            ON CONFLICT (name) DO NOTHING
        `);

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
                subscription_id INTEGER REFERENCES subscriptions(id),
                subscription_ends_at TIMESTAMP,
                trial_ends_at TIMESTAMP,
                max_devices INTEGER DEFAULT 3,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Tabla: branches (sucursales) - DEBE IR ANTES DE EMPLOYEES
        await client.query(`
            CREATE TABLE IF NOT EXISTS branches (
                id SERIAL PRIMARY KEY,
                tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
                branch_code VARCHAR(20) NOT NULL,
                name VARCHAR(255) NOT NULL,
                address TEXT,
                phone_number VARCHAR(20),
                timezone VARCHAR(50) DEFAULT 'America/Mexico_City',
                is_active BOOLEAN DEFAULT true,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(tenant_id, branch_code)
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
                main_branch_id INTEGER REFERENCES branches(id) ON DELETE SET NULL,
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

        // Tabla: employee_branches (relación muchos a muchos entre employees y branches)
        await client.query(`
            CREATE TABLE IF NOT EXISTS employee_branches (
                id SERIAL PRIMARY KEY,
                employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
                branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
                can_login BOOLEAN DEFAULT true,
                can_sell BOOLEAN DEFAULT true,
                can_manage_inventory BOOLEAN DEFAULT false,
                can_close_shift BOOLEAN DEFAULT false,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(employee_id, branch_id)
            )
        `);

        // Tabla: expense_categories (categorías de gastos)
        await client.query(`
            CREATE TABLE IF NOT EXISTS expense_categories (
                id SERIAL PRIMARY KEY,
                tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
                name VARCHAR(100) NOT NULL,
                description TEXT,
                is_active BOOLEAN DEFAULT true,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(tenant_id, name)
            )
        `);

        // Tabla: suppliers (proveedores para compras)
        await client.query(`
            CREATE TABLE IF NOT EXISTS suppliers (
                id SERIAL PRIMARY KEY,
                tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
                name VARCHAR(255) NOT NULL,
                contact_name VARCHAR(255),
                phone_number VARCHAR(20),
                email VARCHAR(255),
                address TEXT,
                is_active BOOLEAN DEFAULT true,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Tabla: purchases (compras)
        await client.query(`
            CREATE TABLE IF NOT EXISTS purchases (
                id SERIAL PRIMARY KEY,
                tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
                branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
                supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
                employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
                purchase_number VARCHAR(50) NOT NULL,
                total_amount DECIMAL(10, 2) NOT NULL,
                payment_status VARCHAR(50) DEFAULT 'pending',
                notes TEXT,
                purchase_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(tenant_id, purchase_number)
            )
        `);

        // Tabla: shifts (turnos de empleados / cortes de caja)
        await client.query(`
            CREATE TABLE IF NOT EXISTS shifts (
                id SERIAL PRIMARY KEY,
                tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
                branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
                employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
                start_time TIMESTAMP NOT NULL,
                end_time TIMESTAMP,
                initial_amount DECIMAL(10, 2) DEFAULT 0,
                final_amount DECIMAL(10, 2) DEFAULT 0,
                transaction_counter INTEGER DEFAULT 0,
                is_cash_cut_open BOOLEAN DEFAULT true,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
                sale_type VARCHAR(50) DEFAULT 'counter',
                sale_date TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
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
                category_id INTEGER REFERENCES expense_categories(id) ON DELETE SET NULL,
                description TEXT,
                amount DECIMAL(10, 2) NOT NULL,
                expense_date TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
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

        // IMPORTANTE: Agregar columnas faltantes si no existen (para tablas creadas antes de esta versión)

        // Migraciones para tenants
        try {
            await client.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS subscription_id INTEGER REFERENCES subscriptions(id)`);
            console.log('[DB] ✅ Columna tenants.subscription_id verificada/agregada');
        } catch (error) {
            console.log('[DB] ⚠️ tenants.subscription_id:', error.message);
        }

        // Migraciones para branches
        try {
            await client.query(`ALTER TABLE branches ADD COLUMN IF NOT EXISTS timezone VARCHAR(50) DEFAULT 'America/Mexico_City'`);
            console.log('[DB] ✅ Columna branches.timezone verificada/agregada');
        } catch (error) {
            console.log('[DB] ⚠️ branches.timezone:', error.message);
        }

        // Migraciones para employees
        try {
            await client.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS main_branch_id INTEGER REFERENCES branches(id) ON DELETE SET NULL`);
            console.log('[DB] ✅ Columna employees.main_branch_id verificada/agregada');
        } catch (error) {
            console.log('[DB] ⚠️ employees.main_branch_id:', error.message);
        }

        // Migraciones para sales
        try {
            await client.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS sale_type VARCHAR(50) DEFAULT 'counter'`);
            console.log('[DB] ✅ Columna sales.sale_type verificada/agregada');
        } catch (error) {
            console.log('[DB] ⚠️ sales.sale_type:', error.message);
        }

        // Migraciones para expenses - agregar category_id
        try {
            await client.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS category_id INTEGER REFERENCES expense_categories(id) ON DELETE SET NULL`);
            console.log('[DB] ✅ Columna expenses.category_id verificada/agregada');
        } catch (error) {
            console.log('[DB] ⚠️ expenses.category_id:', error.message);
        }

        // Migraciones para guardian_events
        try {
            await client.query(`
                ALTER TABLE guardian_events
                ADD COLUMN IF NOT EXISTS event_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            `);
            console.log('[DB] ✅ Columna event_date verificada/agregada');
        } catch (error) {
            console.log('[DB] ⚠️ event_date:', error.message);
        }

        try {
            await client.query(`
                ALTER TABLE guardian_events
                ADD COLUMN IF NOT EXISTS is_read BOOLEAN DEFAULT false
            `);
            console.log('[DB] ✅ Columna is_read verificada/agregada');
        } catch (error) {
            console.log('[DB] ⚠️ is_read:', error.message);
        }

        try {
            await client.query(`
                ALTER TABLE guardian_events
                ADD COLUMN IF NOT EXISTS severity VARCHAR(20) DEFAULT 'medium'
            `);
            console.log('[DB] ✅ Columna severity verificada/agregada');
        } catch (error) {
            console.log('[DB] ⚠️ severity:', error.message);
        }

        try {
            await client.query(`
                ALTER TABLE guardian_events
                ADD COLUMN IF NOT EXISTS metadata JSONB
            `);
            console.log('[DB] ✅ Columna metadata verificada/agregada');
        } catch (error) {
            console.log('[DB] ⚠️ metadata:', error.message);
        }

        // Ahora sí crear los índices (después de asegurar que las columnas existen)
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
