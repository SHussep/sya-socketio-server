// ═══════════════════════════════════════════════════════════════
// DATABASE CONNECTION - PostgreSQL
// ═══════════════════════════════════════════════════════════════

const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// 🌍 CRITICAL: Set timezone to UTC for ALL connections
// This ensures PostgreSQL interprets all timestamps in UTC, not in system timezone
pool.on('connect', async (client) => {
    try {
        await client.query("SET timezone = 'UTC'");
        console.log('✅ Connected to PostgreSQL database (timezone: UTC)');
    } catch (error) {
        console.error('❌ Error setting timezone:', error.message);
    }
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
        // NOTE: Schema matches schema.sql - no 'price' column
        await client.query(`
            CREATE TABLE IF NOT EXISTS subscriptions (
                id SERIAL PRIMARY KEY,
                name VARCHAR(100) UNIQUE NOT NULL,
                max_branches INTEGER NOT NULL DEFAULT 1,
                max_devices INTEGER NOT NULL DEFAULT 1,
                max_devices_per_branch INTEGER NOT NULL DEFAULT 3,
                max_employees INTEGER,
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

        // Insertar planes por defecto si no existen
        // NOTE: Schema doesn't have 'price' column - matches schema.sql
        try {
            await client.query(`
                INSERT INTO subscriptions (name, max_branches, max_devices, max_devices_per_branch, max_employees, features)
                VALUES
                    ('Basic', 1, 1, 3, 5, '{"guardian": true, "reports": true}'),
                    ('Pro', 3, 10, 5, 20, '{"guardian": true, "reports": true, "advanced_analytics": true}'),
                    ('Enterprise', 10, 50, 10, 100, '{"guardian": true, "reports": true, "advanced_analytics": true, "custom_features": true}')
                ON CONFLICT (name) DO NOTHING
            `);
        } catch (error) {
            console.log('[DB] ⚠️ subscriptions insert error:', error.message);
            // Don't throw - continue initialization
        }

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
                is_active BOOLEAN DEFAULT true,
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

        // Tabla: roles (debe ir ANTES de employees)
        await client.query(`
            CREATE TABLE IF NOT EXISTS roles (
                id INTEGER PRIMARY KEY,
                name VARCHAR(100) NOT NULL UNIQUE,
                description TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Insertar roles por defecto si no existen
        await client.query(`
            INSERT INTO roles (id, name, description) VALUES
            (1, 'Administrador', 'Acceso total al sistema'),
            (2, 'Encargado', 'Gestión de sucursal y empleados'),
            (3, 'Repartidor', 'Entrega de pedidos'),
            (4, 'Ayudante', 'Ayudante de tortillería')
            ON CONFLICT (id) DO NOTHING
        `);

        // Tabla: employees
        await client.query(`
            CREATE TABLE IF NOT EXISTS employees (
                id SERIAL PRIMARY KEY,
                tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
                username VARCHAR(100) NOT NULL,
                first_name VARCHAR(100),
                last_name VARCHAR(100),
                email VARCHAR(255),
                password_hash VARCHAR(255),
                password_updated_at TIMESTAMP,
                role_id INTEGER REFERENCES roles(id) ON DELETE RESTRICT,
                is_active BOOLEAN DEFAULT TRUE,
                is_owner BOOLEAN DEFAULT FALSE,
                mobile_access_type VARCHAR(50) DEFAULT 'none',
                can_use_mobile_app BOOLEAN DEFAULT FALSE,
                google_user_identifier VARCHAR(255),
                main_branch_id INTEGER REFERENCES branches(id),
                global_id VARCHAR(255) UNIQUE NOT NULL,
                terminal_id VARCHAR(100),
                local_op_seq BIGINT,
                created_local_utc TEXT,
                device_event_raw BIGINT,
                email_verified BOOLEAN DEFAULT NULL,
                verification_code VARCHAR(6),
                verification_expires_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(tenant_id, username),
                UNIQUE(tenant_id, email)
            )
        `);

        // ⚠️ MIGRACIÓN CRÍTICA: Recrear tabla devices con schema correcto
        console.log('[Schema] 🔄 Verificando schema de tabla devices...');
        try {
            // Verificar si existe la tabla con schema viejo (id como VARCHAR)
            const schemaCheck = await client.query(`
                SELECT column_name, data_type
                FROM information_schema.columns
                WHERE table_name = 'devices' AND column_name = 'id'
            `);

            if (schemaCheck.rows.length > 0 && schemaCheck.rows[0].data_type === 'character varying') {
                console.log('[Schema] ⚠️ Detectado schema viejo de devices (id VARCHAR) - RECREANDO tabla...');

                // Eliminar tabla vieja (CASCADE elimina FK dependencies)
                await client.query(`DROP TABLE IF EXISTS devices CASCADE`);
                console.log('[Schema] ✅ Tabla devices vieja eliminada');
            }
        } catch (checkError) {
            console.log('[Schema] ℹ️ Tabla devices no existe o error verificando schema:', checkError.message);
        }

        // Tabla: devices (schema correcto con SERIAL id)
        await client.query(`
            CREATE TABLE IF NOT EXISTS devices (
                id SERIAL PRIMARY KEY,
                tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
                branch_id INTEGER REFERENCES branches(id) ON DELETE SET NULL,
                employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
                device_id TEXT,
                device_name VARCHAR(255),
                device_type VARCHAR(50) NOT NULL,
                platform VARCHAR(50),
                device_token TEXT,
                is_active BOOLEAN DEFAULT true,
                last_seen TIMESTAMP,
                last_active TIMESTAMP,
                linked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log('[Schema] ✅ Tabla devices creada con schema correcto (id SERIAL)');

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

        // Tabla: global_expense_categories (categorías de gastos GLOBALES con IDs canónicos 1-14)
        await client.query(`
            CREATE TABLE IF NOT EXISTS global_expense_categories (
                id INTEGER PRIMARY KEY,
                name VARCHAR(100) NOT NULL UNIQUE,
                description TEXT,
                is_measurable BOOLEAN DEFAULT FALSE,
                unit_abbreviation VARCHAR(10),
                is_available BOOLEAN DEFAULT TRUE,
                sort_order INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Tabla: suppliers (proveedores para compras)
        await client.query(`
            CREATE TABLE IF NOT EXISTS suppliers (
                id SERIAL PRIMARY KEY,
                tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
                name VARCHAR(255) NOT NULL,
                contact_name VARCHAR(255),
                phone_number VARCHAR(50),
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


        // Tabla: expenses (gastos)
        await client.query(`
            CREATE TABLE IF NOT EXISTS expenses (
                id SERIAL PRIMARY KEY,
                tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
                branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
                employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
                global_category_id INTEGER REFERENCES global_expense_categories(id) ON DELETE SET NULL,
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

        // ⚠️ TABLA OBSOLETA: guardian_events → ahora se usan tablas específicas (migration 057)
        // Migration 057 crea: scale_disconnections, suspicious_weighing_events, guardian_employee_scores_daily
        // NO crear tabla 'guardian_events' genérica aquí para evitar conflictos
        /*
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
        */

        // Índices básicos
        await client.query('CREATE INDEX IF NOT EXISTS idx_employees_tenant_id ON employees(tenant_id)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_employees_email ON employees(email)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_devices_tenant_id ON devices(tenant_id)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_sessions_tenant_id ON sessions(tenant_id)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_branches_tenant_id ON branches(tenant_id)');

        // ⚠️ ÍNDICES OBSOLETOS: sales → ahora se usan índices en 'ventas' (migration 046)
        // await client.query('CREATE INDEX IF NOT EXISTS idx_sales_tenant_id ON sales(tenant_id)');
        // await client.query('CREATE INDEX IF NOT EXISTS idx_sales_branch_id ON sales(branch_id)');
        // await client.query('CREATE INDEX IF NOT EXISTS idx_sales_date ON sales(sale_date DESC)');

        await client.query('CREATE INDEX IF NOT EXISTS idx_expenses_tenant_id ON expenses(tenant_id)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_expenses_branch_id ON expenses(branch_id)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(expense_date DESC)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_cash_cuts_tenant_id ON cash_cuts(tenant_id)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_cash_cuts_branch_id ON cash_cuts(branch_id)');

        // ⚠️ ÍNDICES OBSOLETOS: guardian_events → ahora se usan tablas específicas (migration 057)
        // await client.query('CREATE INDEX IF NOT EXISTS idx_guardian_events_tenant_id ON guardian_events(tenant_id)');
        // await client.query('CREATE INDEX IF NOT EXISTS idx_guardian_events_branch_id ON guardian_events(branch_id)');

        // IMPORTANTE: Agregar columnas faltantes si no existen (para tablas creadas antes de esta versión)

        // Migraciones para tenants
        try {
            await client.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS subscription_id INTEGER REFERENCES subscriptions(id)`);
            console.log('[DB] ✅ Columna tenants.subscription_id verificada/agregada');
        } catch (error) {
            console.log('[DB] ⚠️ tenants.subscription_id:', error.message);
        }

        // is_active ahora está en el CREATE TABLE inicial (línea 103)
        // Este ALTER TABLE se mantiene solo para compatibilidad con BDs existentes creadas antes del fix
        try {
            await client.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true`);
            console.log('[DB] ✅ Columna tenants.is_active verificada/agregada (compatibilidad con BDs antiguas)');
        } catch (error) {
            console.log('[DB] ⚠️ tenants.is_active:', error.message);
        }

        try {
            await client.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS subscription_plan VARCHAR(50) DEFAULT 'basic'`);
            console.log('[DB] ✅ Columna tenants.subscription_plan verificada/agregada');
        } catch (error) {
            console.log('[DB] ⚠️ tenants.subscription_plan:', error.message);
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
            await client.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS first_name VARCHAR(100)`);
            console.log('[DB] ✅ Columna employees.first_name verificada/agregada');
        } catch (error) {
            console.log('[DB] ⚠️ employees.first_name:', error.message);
        }

        try {
            await client.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS last_name VARCHAR(100)`);
            console.log('[DB] ✅ Columna employees.last_name verificada/agregada');
        } catch (error) {
            console.log('[DB] ⚠️ employees.last_name:', error.message);
        }

        try {
            await client.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255)`);
            console.log('[DB] ✅ Columna employees.password_hash verificada/agregada');
        } catch (error) {
            console.log('[DB] ⚠️ employees.password_hash:', error.message);
        }

        try {
            await client.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS password_updated_at TIMESTAMP`);
            console.log('[DB] ✅ Columna employees.password_updated_at verificada/agregada');
        } catch (error) {
            console.log('[DB] ⚠️ employees.password_updated_at:', error.message);
        }

        try {
            await client.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS role_id INTEGER REFERENCES roles(id) ON DELETE RESTRICT`);
            console.log('[DB] ✅ Columna employees.role_id verificada/agregada');
        } catch (error) {
            console.log('[DB] ⚠️ employees.role_id:', error.message);
        }

        try {
            await client.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS is_owner BOOLEAN DEFAULT FALSE`);
            console.log('[DB] ✅ Columna employees.is_owner verificada/agregada');
        } catch (error) {
            console.log('[DB] ⚠️ employees.is_owner:', error.message);
        }

        try {
            await client.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS mobile_access_type VARCHAR(50) DEFAULT 'none'`);
            console.log('[DB] ✅ Columna employees.mobile_access_type verificada/agregada');
        } catch (error) {
            console.log('[DB] ⚠️ employees.mobile_access_type:', error.message);
        }

        try {
            await client.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS can_use_mobile_app BOOLEAN DEFAULT FALSE`);
            console.log('[DB] ✅ Columna employees.can_use_mobile_app verificada/agregada');
        } catch (error) {
            console.log('[DB] ⚠️ employees.can_use_mobile_app:', error.message);
        }

        try {
            await client.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS google_user_identifier VARCHAR(255)`);
            console.log('[DB] ✅ Columna employees.google_user_identifier verificada/agregada');
        } catch (error) {
            console.log('[DB] ⚠️ employees.google_user_identifier:', error.message);
        }

        try {
            await client.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS main_branch_id INTEGER REFERENCES branches(id) ON DELETE SET NULL`);
            console.log('[DB] ✅ Columna employees.main_branch_id verificada/agregada');
        } catch (error) {
            console.log('[DB] ⚠️ employees.main_branch_id:', error.message);
        }

        try {
            await client.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS global_id VARCHAR(255) UNIQUE`);
            console.log('[DB] ✅ Columna employees.global_id verificada/agregada');
        } catch (error) {
            console.log('[DB] ⚠️ employees.global_id:', error.message);
        }

        try {
            await client.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS terminal_id VARCHAR(100)`);
            console.log('[DB] ✅ Columna employees.terminal_id verificada/agregada');
        } catch (error) {
            console.log('[DB] ⚠️ employees.terminal_id:', error.message);
        }

        try {
            await client.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS local_op_seq BIGINT`);
            console.log('[DB] ✅ Columna employees.local_op_seq verificada/agregada');
        } catch (error) {
            console.log('[DB] ⚠️ employees.local_op_seq:', error.message);
        }

        try {
            await client.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS created_local_utc TEXT`);
            console.log('[DB] ✅ Columna employees.created_local_utc verificada/agregada');
        } catch (error) {
            console.log('[DB] ⚠️ employees.created_local_utc:', error.message);
        }

        try {
            await client.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS device_event_raw BIGINT`);
            console.log('[DB] ✅ Columna employees.device_event_raw verificada/agregada');
        } catch (error) {
            console.log('[DB] ⚠️ employees.device_event_raw:', error.message);
        }

        // ⚠️ MIGRACIÓN OBSOLETA: sales → ahora se usa 'ventas' (migration 046)
        /*
        try {
            await client.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS sale_type VARCHAR(50) DEFAULT 'counter'`);
            console.log('[DB] ✅ Columna sales.sale_type verificada/agregada');
        } catch (error) {
            console.log('[DB] ⚠️ sales.sale_type:', error.message);
        }
        */

        // Migraciones para expenses - agregar global_category_id
        try {
            await client.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS global_category_id INTEGER REFERENCES global_expense_categories(id) ON DELETE SET NULL`);
            console.log('[DB] ✅ Columna expenses.global_category_id verificada/agregada');
        } catch (error) {
            console.log('[DB] ⚠️ expenses.global_category_id:', error.message);
        }

        // ⚠️ MIGRACIONES OBSOLETAS: guardian_events → ahora se usan tablas específicas (migration 057)
        /*
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

        // Índices para guardian_events
        await client.query('CREATE INDEX IF NOT EXISTS idx_guardian_events_date ON guardian_events(event_date DESC)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_guardian_events_unread ON guardian_events(tenant_id, is_read) WHERE is_read = false');
        */

        // ═══════════════════════════════════════════════════════════════════════════════
        // MIGRACIONES PARA EMAIL VERIFICATION (verificación de correo de empleados)
        // ═══════════════════════════════════════════════════════════════════════════════
        try {
            await client.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT NULL`);
            console.log('[DB] ✅ Columna employees.email_verified verificada/agregada');
        } catch (error) {
            console.log('[DB] ⚠️ employees.email_verified:', error.message);
        }

        try {
            await client.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS verification_code VARCHAR(6)`);
            console.log('[DB] ✅ Columna employees.verification_code verificada/agregada');
        } catch (error) {
            console.log('[DB] ⚠️ employees.verification_code:', error.message);
        }

        try {
            await client.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS verification_expires_at TIMESTAMP`);
            console.log('[DB] ✅ Columna employees.verification_expires_at verificada/agregada');
        } catch (error) {
            console.log('[DB] ⚠️ employees.verification_expires_at:', error.message);
        }

        console.log('[DB] ✅ Database schema initialized successfully');
    } catch (error) {
        console.error('[DB] ❌ Error initializing database:', error);
        throw error;
    } finally {
        client.release();
    }
}

// Execute schema and seeds (replaces old migration system)
async function runMigrations() {
    const fs = require('fs');
    const path = require('path');

    try {
        console.log('[Schema] 🔄 Initializing database schema...');

        const client = await pool.connect();

        try {
            // 1. Check if database is empty (no tenants table exists)
            const checkTable = await client.query(`
                SELECT EXISTS (
                    SELECT FROM information_schema.tables
                    WHERE table_name = 'tenants'
                );
            `);

            const tablesExist = checkTable.rows[0].exists;

            if (!tablesExist) {
                console.log('[Schema] 📝 Database is empty - Running schema.sql...');

                // Execute schema.sql
                const schemaPath = path.join(__dirname, 'schema.sql');
                if (fs.existsSync(schemaPath)) {
                    const schemaSql = fs.readFileSync(schemaPath, 'utf8');
                    await client.query('BEGIN');
                    await client.query(schemaSql);
                    await client.query('COMMIT');
                    console.log('[Schema] ✅ Schema created successfully');
                } else {
                    console.error('[Schema] ❌ schema.sql not found!');
                    throw new Error('schema.sql file missing');
                }
            } else {
                console.log('[Schema] ℹ️ Database already initialized, skipping schema.sql');
            }

            // 2. Apply schema patches (for existing databases)
            console.log('[Schema] 🔧 Checking for schema updates...');

            // Patch: Add max_devices_per_branch if missing
            const checkColumn = await client.query(`
                SELECT column_name
                FROM information_schema.columns
                WHERE table_name = 'subscriptions'
                AND column_name = 'max_devices_per_branch'
            `);

            if (checkColumn.rows.length === 0) {
                console.log('[Schema] 📝 Adding missing column: subscriptions.max_devices_per_branch');
                await client.query(`
                    ALTER TABLE subscriptions
                    ADD COLUMN IF NOT EXISTS max_devices_per_branch INTEGER NOT NULL DEFAULT 3
                `);
                console.log('[Schema] ✅ Column added successfully');
            }

            // Patch: Fix repartidor_assignments column naming (id_venta vs venta_id)
            const checkRepartidorColumns = await client.query(`
                SELECT column_name
                FROM information_schema.columns
                WHERE table_name = 'repartidor_assignments'
                AND column_name IN ('id_venta', 'venta_id')
                ORDER BY column_name
            `);

            const hasIdVenta = checkRepartidorColumns.rows.some(r => r.column_name === 'id_venta');
            const hasVentaId = checkRepartidorColumns.rows.some(r => r.column_name === 'venta_id');

            if (hasIdVenta && hasVentaId) {
                // Both columns exist - drop the old one
                console.log('[Schema] 📝 Removing duplicate column: repartidor_assignments.id_venta (keeping venta_id)');
                await client.query(`
                    ALTER TABLE repartidor_assignments
                    DROP COLUMN IF EXISTS id_venta CASCADE
                `);
                console.log('[Schema] ✅ Duplicate column removed successfully');
            } else if (hasIdVenta && !hasVentaId) {
                // Only old column exists - rename it
                console.log('[Schema] 📝 Renaming column: repartidor_assignments.id_venta → venta_id');
                await client.query(`
                    ALTER TABLE repartidor_assignments
                    RENAME COLUMN id_venta TO venta_id
                `);
                console.log('[Schema] ✅ Column renamed successfully');
            }

            // Patch: Fix ventas unique constraint (per shift, not per branch)
            // Only run if ventas table exists
            const checkVentasTable = await client.query(`
                SELECT EXISTS (
                    SELECT FROM information_schema.tables
                    WHERE table_name = 'ventas'
                )
            `);

            if (checkVentasTable.rows[0].exists) {
                console.log('[Schema] 🔍 Checking ventas unique constraints...');
                const checkVentasConstraints = await client.query(`
                    SELECT constraint_name
                    FROM information_schema.table_constraints
                    WHERE table_name = 'ventas'
                    AND constraint_type = 'UNIQUE'
                    AND constraint_name IN ('ventas_uq_ticket_per_branch', 'uq_ventas_ticket_per_terminal', 'uq_ventas_ticket_per_shift')
                `);

            const constraints = checkVentasConstraints.rows.map(r => r.constraint_name);
            console.log(`[Schema] 📋 Found constraints: ${constraints.join(', ') || 'none'}`);

            // Drop old incorrect constraints
            if (constraints.includes('ventas_uq_ticket_per_branch')) {
                console.log('[Schema] 📝 Removing incorrect constraint: ventas_uq_ticket_per_branch (tickets are unique per shift, not per branch)');
                await client.query(`DROP INDEX IF EXISTS ventas_uq_ticket_per_branch CASCADE`);
                console.log('[Schema] ✅ Constraint removed');
            }

            if (constraints.includes('uq_ventas_ticket_per_terminal')) {
                console.log('[Schema] 📝 Removing incorrect constraint: uq_ventas_ticket_per_terminal (tickets are unique per shift, not per terminal)');
                await client.query(`DROP INDEX IF EXISTS uq_ventas_ticket_per_terminal CASCADE`);
                console.log('[Schema] ✅ Constraint removed');
            }

            // Create correct constraint if missing
            if (!constraints.includes('uq_ventas_ticket_per_shift')) {
                console.log('[Schema] 📝 Creating correct constraint: uq_ventas_ticket_per_shift (tenant_id, branch_id, ticket_number, id_turno)');
                await client.query(`
                    CREATE UNIQUE INDEX IF NOT EXISTS uq_ventas_ticket_per_shift
                    ON ventas(tenant_id, branch_id, ticket_number, id_turno)
                `);
                console.log('[Schema] ✅ Constraint created successfully');
            }
            } else {
                console.log('[Schema] ℹ️  Fresh database created - skipping patches');
            }

            // Patch: Add Guardian missing columns (is_hidden, severity, etc.)
            console.log('[Schema] 🔍 Checking Guardian tables for missing columns...');

            // Check if suspicious_weighing_logs exists
            const checkSuspiciousTable = await client.query(`
                SELECT EXISTS (
                    SELECT FROM information_schema.tables
                    WHERE table_name = 'suspicious_weighing_logs'
                )
            `);

            if (checkSuspiciousTable.rows[0].exists) {
                // Add is_hidden to suspicious_weighing_logs
                const checkSuspiciousHidden = await client.query(`
                    SELECT column_name
                    FROM information_schema.columns
                    WHERE table_name = 'suspicious_weighing_logs'
                    AND column_name = 'is_hidden'
                `);

                if (checkSuspiciousHidden.rows.length === 0) {
                    console.log('[Schema] 📝 Adding missing column: suspicious_weighing_logs.is_hidden');
                    await client.query(`
                        ALTER TABLE suspicious_weighing_logs
                        ADD COLUMN is_hidden BOOLEAN DEFAULT FALSE
                    `);
                    // Add index
                    await client.query(`
                        CREATE INDEX IF NOT EXISTS idx_suspicious_weighing_logs_is_hidden
                        ON suspicious_weighing_logs(is_hidden) WHERE is_hidden = false
                    `);
                    console.log('[Schema] ✅ Column suspicious_weighing_logs.is_hidden added successfully');
                }
            }

            // Check if scale_disconnection_logs exists
            const checkDisconnectionTable = await client.query(`
                SELECT EXISTS (
                    SELECT FROM information_schema.tables
                    WHERE table_name = 'scale_disconnection_logs'
                )
            `);

            if (checkDisconnectionTable.rows[0].exists) {
                // Add is_hidden to scale_disconnection_logs
                const checkDisconnectionHidden = await client.query(`
                    SELECT column_name
                    FROM information_schema.columns
                    WHERE table_name = 'scale_disconnection_logs'
                    AND column_name = 'is_hidden'
                `);

                if (checkDisconnectionHidden.rows.length === 0) {
                    console.log('[Schema] 📝 Adding missing column: scale_disconnection_logs.is_hidden');
                    await client.query(`
                        ALTER TABLE scale_disconnection_logs
                        ADD COLUMN is_hidden BOOLEAN DEFAULT FALSE
                    `);
                    // Add index
                    await client.query(`
                        CREATE INDEX IF NOT EXISTS idx_scale_disconnection_logs_is_hidden
                        ON scale_disconnection_logs(is_hidden) WHERE is_hidden = false
                    `);
                    console.log('[Schema] ✅ Column scale_disconnection_logs.is_hidden added successfully');
                }

                // Add severity to scale_disconnection_logs
                const checkDisconnectionSeverity = await client.query(`
                    SELECT column_name
                    FROM information_schema.columns
                    WHERE table_name = 'scale_disconnection_logs'
                    AND column_name = 'severity'
                `);

                if (checkDisconnectionSeverity.rows.length === 0) {
                    console.log('[Schema] 📝 Adding missing column: scale_disconnection_logs.severity');
                    await client.query(`
                        ALTER TABLE scale_disconnection_logs
                        ADD COLUMN severity VARCHAR(50) DEFAULT 'Medium'
                    `);
                    // Add index
                    await client.query(`
                        CREATE INDEX IF NOT EXISTS idx_scale_disconnection_logs_severity
                        ON scale_disconnection_logs(severity)
                    `);
                    console.log('[Schema] ✅ Column scale_disconnection_logs.severity added successfully');
                }

                // Rename 'status' to 'disconnection_status' if needed
                const checkDisconnectionStatus = await client.query(`
                    SELECT column_name
                    FROM information_schema.columns
                    WHERE table_name = 'scale_disconnection_logs'
                    AND column_name IN ('status', 'disconnection_status')
                    ORDER BY column_name
                `);

                const hasStatus = checkDisconnectionStatus.rows.some(r => r.column_name === 'status');
                const hasDisconnectionStatus = checkDisconnectionStatus.rows.some(r => r.column_name === 'disconnection_status');

                if (hasStatus && !hasDisconnectionStatus) {
                    console.log('[Schema] 📝 Renaming column: scale_disconnection_logs.status → disconnection_status');
                    await client.query(`
                        ALTER TABLE scale_disconnection_logs
                        RENAME COLUMN status TO disconnection_status
                    `);
                    console.log('[Schema] ✅ Column renamed successfully');
                }
            }

            // Patch: Create employee_debts table if missing (for cash drawer shortages)
            console.log('[Schema] 🔍 Checking employee_debts table...');
            const checkEmployeeDebtsTable = await client.query(`
                SELECT EXISTS (
                    SELECT FROM information_schema.tables
                    WHERE table_name = 'employee_debts'
                )
            `);

            if (!checkEmployeeDebtsTable.rows[0].exists) {
                console.log('[Schema] 📝 Creating table: employee_debts (faltantes de corte de caja)');
                // Note: cash_cut_id references cash_cuts table (cortes de caja in PostgreSQL)
                // Desktop uses CashDrawerSession locally, which syncs to cash_cuts in PG
                await client.query(`
                    CREATE TABLE employee_debts (
                        id SERIAL PRIMARY KEY,
                        global_id VARCHAR(50) UNIQUE NOT NULL,
                        tenant_id INTEGER NOT NULL REFERENCES tenants(id),
                        branch_id INTEGER NOT NULL REFERENCES branches(id),
                        employee_id INTEGER NOT NULL REFERENCES employees(id),
                        cash_cut_id INTEGER REFERENCES cash_cuts(id),
                        shift_id INTEGER REFERENCES shifts(id),
                        monto_deuda DECIMAL(12, 2) NOT NULL DEFAULT 0,
                        monto_pagado DECIMAL(12, 2) NOT NULL DEFAULT 0,
                        estado VARCHAR(30) NOT NULL DEFAULT 'pendiente',
                        fecha_deuda TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
                        fecha_pago TIMESTAMP WITH TIME ZONE,
                        notas TEXT,
                        terminal_id VARCHAR(50),
                        local_op_seq BIGINT,
                        device_event_raw BIGINT,
                        created_local_utc VARCHAR(50),
                        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
                    )
                `);
                // Create indexes
                await client.query(`CREATE INDEX IF NOT EXISTS idx_employee_debts_tenant ON employee_debts(tenant_id)`);
                await client.query(`CREATE INDEX IF NOT EXISTS idx_employee_debts_branch ON employee_debts(branch_id)`);
                await client.query(`CREATE INDEX IF NOT EXISTS idx_employee_debts_employee ON employee_debts(employee_id)`);
                await client.query(`CREATE INDEX IF NOT EXISTS idx_employee_debts_estado ON employee_debts(estado)`);
                await client.query(`CREATE INDEX IF NOT EXISTS idx_employee_debts_fecha ON employee_debts(fecha_deuda)`);
                console.log('[Schema] ✅ Table employee_debts created successfully');
            }

            // Patch: Add CHECK constraint to ensure monto_deuda is always positive
            console.log('[Schema] 🔍 Checking employee_debts CHECK constraint for positive amounts...');
            const checkConstraint = await client.query(`
                SELECT constraint_name
                FROM information_schema.table_constraints
                WHERE table_name = 'employee_debts'
                  AND constraint_type = 'CHECK'
                  AND constraint_name = 'check_monto_deuda_positive'
            `);

            if (checkConstraint.rows.length === 0) {
                console.log('[Schema] 📝 Adding CHECK constraint: monto_deuda must be positive');
                // First, clean up any existing invalid data
                await client.query(`
                    UPDATE employee_debts
                    SET monto_deuda = ABS(monto_deuda),
                        notas = COALESCE(notas, '') || ' [AUTO-CORRECTED: was negative]'
                    WHERE monto_deuda < 0
                `);
                await client.query(`DELETE FROM employee_debts WHERE monto_deuda = 0`);

                // Now add the constraint
                await client.query(`
                    ALTER TABLE employee_debts
                    ADD CONSTRAINT check_monto_deuda_positive
                    CHECK (monto_deuda > 0)
                `);
                console.log('[Schema] ✅ CHECK constraint added - monto_deuda must be > 0');
            }

            // Patch: Add credito_original to ventas table if missing (for credit audit trail)
            if (checkVentasTable.rows[0].exists) {
                const checkCreditoOriginal = await client.query(`
                    SELECT column_name
                    FROM information_schema.columns
                    WHERE table_name = 'ventas'
                    AND column_name = 'credito_original'
                `);

                if (checkCreditoOriginal.rows.length === 0) {
                    console.log('[Schema] 📝 Adding missing column: ventas.credito_original');
                    await client.query(`
                        ALTER TABLE ventas
                        ADD COLUMN credito_original DECIMAL(12, 2) NOT NULL DEFAULT 0
                    `);
                    // Recalculate for existing sales
                    console.log('[Schema] 📝 Recalculating credito_original for existing ventas...');
                    // Contado (tipo 1,2): credito = 0
                    await client.query(`UPDATE ventas SET credito_original = 0 WHERE tipo_pago_id IN (1, 2)`);
                    // Crédito puro (tipo 3): credito = total
                    await client.query(`UPDATE ventas SET credito_original = total WHERE tipo_pago_id = 3`);
                    // Mixto (tipo 4): credito = total - monto_pagado (aproximación)
                    await client.query(`UPDATE ventas SET credito_original = GREATEST(0, total - monto_pagado) WHERE tipo_pago_id = 4`);
                    // Create index
                    await client.query(`
                        CREATE INDEX IF NOT EXISTS idx_ventas_credito_original
                        ON ventas(credito_original) WHERE credito_original > 0
                    `);
                    console.log('[Schema] ✅ Column ventas.credito_original added and calculated successfully');
                }

                // Patch: Add has_nota_credito to ventas table if missing
                const checkHasNotaCredito = await client.query(`
                    SELECT column_name
                    FROM information_schema.columns
                    WHERE table_name = 'ventas'
                    AND column_name = 'has_nota_credito'
                `);

                if (checkHasNotaCredito.rows.length === 0) {
                    console.log('[Schema] 📝 Adding missing column: ventas.has_nota_credito');
                    await client.query(`
                        ALTER TABLE ventas
                        ADD COLUMN has_nota_credito BOOLEAN DEFAULT FALSE
                    `);
                    // Update existing ventas that have notas de credito
                    console.log('[Schema] 📝 Updating has_nota_credito for existing ventas...');
                    await client.query(`
                        UPDATE ventas v
                        SET has_nota_credito = TRUE
                        WHERE EXISTS (
                            SELECT 1 FROM notas_credito nc
                            WHERE nc.venta_id = v.id AND nc.estado != 'cancelled'
                        )
                    `);
                    console.log('[Schema] ✅ Column ventas.has_nota_credito added successfully');
                }
            }

            // Patch: Add offline-first columns to purchases table
            const checkPurchasesTable = await client.query(`
                SELECT EXISTS (
                    SELECT FROM information_schema.tables
                    WHERE table_name = 'purchases'
                );
            `);

            if (checkPurchasesTable.rows[0].exists) {
                // First, drop FK constraint on supplier_id if exists (suppliers aren't synced)
                try {
                    await client.query(`
                        ALTER TABLE purchases DROP CONSTRAINT IF EXISTS purchases_supplier_id_fkey
                    `);
                    console.log('[Schema] ℹ️ Dropped purchases_supplier_id_fkey constraint (suppliers not synced)');
                } catch (fkErr) {
                    // Ignore if doesn't exist
                }

                const checkPurchaseGlobalId = await client.query(`
                    SELECT column_name
                    FROM information_schema.columns
                    WHERE table_name = 'purchases'
                    AND column_name = 'global_id'
                `);

                if (checkPurchaseGlobalId.rows.length === 0) {
                    console.log('[Schema] 📝 Adding offline-first columns to purchases table...');

                    await client.query(`
                        ALTER TABLE purchases
                        ADD COLUMN IF NOT EXISTS global_id VARCHAR(36) UNIQUE,
                        ADD COLUMN IF NOT EXISTS terminal_id VARCHAR(100),
                        ADD COLUMN IF NOT EXISTS local_op_seq BIGINT,
                        ADD COLUMN IF NOT EXISTS created_local_utc VARCHAR(50),
                        ADD COLUMN IF NOT EXISTS last_modified_local_utc VARCHAR(50),
                        ADD COLUMN IF NOT EXISTS supplier_name VARCHAR(200),
                        ADD COLUMN IF NOT EXISTS shift_id INTEGER,
                        ADD COLUMN IF NOT EXISTS subtotal DECIMAL(12,2) DEFAULT 0,
                        ADD COLUMN IF NOT EXISTS taxes DECIMAL(12,2) DEFAULT 0,
                        ADD COLUMN IF NOT EXISTS amount_paid DECIMAL(12,2) DEFAULT 0,
                        ADD COLUMN IF NOT EXISTS payment_type_id INTEGER,
                        ADD COLUMN IF NOT EXISTS invoice_number VARCHAR(100),
                        ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW()
                    `);

                    await client.query(`
                        CREATE INDEX IF NOT EXISTS idx_purchases_global_id ON purchases(global_id)
                    `);

                    console.log('[Schema] ✅ Purchases offline-first columns added successfully');
                }

                // Create purchase_details table if not exists
                const checkPurchaseDetails = await client.query(`
                    SELECT EXISTS (
                        SELECT FROM information_schema.tables
                        WHERE table_name = 'purchase_details'
                    );
                `);

                if (!checkPurchaseDetails.rows[0].exists) {
                    console.log('[Schema] 📝 Creating purchase_details table...');
                    await client.query(`
                        CREATE TABLE purchase_details (
                            id SERIAL PRIMARY KEY,
                            purchase_id INTEGER NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
                            product_id BIGINT,
                            product_name VARCHAR(200),
                            quantity DECIMAL(12,3) DEFAULT 0,
                            unit_price DECIMAL(12,2) DEFAULT 0,
                            subtotal DECIMAL(12,2) DEFAULT 0,
                            global_id VARCHAR(36) UNIQUE,
                            created_at TIMESTAMP DEFAULT NOW()
                        )
                    `);
                    await client.query(`
                        CREATE INDEX IF NOT EXISTS idx_purchase_details_purchase_id ON purchase_details(purchase_id)
                    `);
                    await client.query(`
                        CREATE INDEX IF NOT EXISTS idx_purchase_details_global_id ON purchase_details(global_id)
                    `);
                    console.log('[Schema] ✅ purchase_details table created successfully');
                }
            }

            // Patch: Add RFC column to branches table if missing
            const checkBranchesRfc = await client.query(`
                SELECT column_name
                FROM information_schema.columns
                WHERE table_name = 'branches'
                AND column_name = 'rfc'
            `);

            if (checkBranchesRfc.rows.length === 0) {
                console.log('[Schema] 📝 Adding missing column: branches.rfc');
                await client.query(`
                    ALTER TABLE branches
                    ADD COLUMN IF NOT EXISTS rfc VARCHAR(20)
                `);
                console.log('[Schema] ✅ branches.rfc column added successfully');
            }

            // Patch: Create telemetry_events table if not exists
            const checkTelemetryTable = await client.query(`
                SELECT table_name FROM information_schema.tables
                WHERE table_name = 'telemetry_events'
            `);

            if (checkTelemetryTable.rows.length === 0) {
                console.log('[Schema] 📝 Creating telemetry_events table...');
                await client.query(`
                    CREATE TABLE IF NOT EXISTS telemetry_events (
                        id SERIAL PRIMARY KEY,
                        tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
                        branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
                        event_type VARCHAR(50) NOT NULL,
                        device_id VARCHAR(255),
                        device_name VARCHAR(255),
                        app_version VARCHAR(50),
                        scale_model VARCHAR(100),
                        scale_port VARCHAR(50),
                        global_id VARCHAR(255) UNIQUE NOT NULL,
                        terminal_id VARCHAR(100),
                        local_op_seq BIGINT,
                        device_event_raw BIGINT,
                        created_local_utc TEXT,
                        event_timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    );
                    CREATE INDEX IF NOT EXISTS idx_telemetry_tenant_id ON telemetry_events(tenant_id);
                    CREATE INDEX IF NOT EXISTS idx_telemetry_branch_id ON telemetry_events(branch_id);
                    CREATE INDEX IF NOT EXISTS idx_telemetry_event_type ON telemetry_events(event_type);
                    CREATE INDEX IF NOT EXISTS idx_telemetry_event_timestamp ON telemetry_events(event_timestamp);
                `);
                console.log('[Schema] ✅ telemetry_events table created successfully');
            }

            // 2.5. Clean user data if requested (for testing)
            console.log(`[Schema] 🔍 CLEAN_DATABASE_ON_START = "${process.env.CLEAN_DATABASE_ON_START}"`);

            if (process.env.CLEAN_DATABASE_ON_START === 'true') {
                console.log('[Schema] 🗑️  CLEAN_DATABASE_ON_START=true - Dropping user tables...');
                const cleanPath = path.join(__dirname, 'migrations', '999_clean_user_data.sql');
                console.log(`[Schema] 📂 Clean script path: ${cleanPath}`);
                console.log(`[Schema] 📂 File exists: ${fs.existsSync(cleanPath)}`);

                if (fs.existsSync(cleanPath)) {
                    try {
                        const cleanSql = fs.readFileSync(cleanPath, 'utf8');
                        console.log('[Schema] 📝 Executing DROP script...');
                        await client.query(cleanSql);
                        console.log('[Schema] ✅ User tables dropped successfully (seeds preserved)');

                        // Now recreate tables from schema.sql
                        console.log('[Schema] 📝 Recreating tables from schema.sql...');
                        const schemaPath = path.join(__dirname, 'schema.sql');
                        if (fs.existsSync(schemaPath)) {
                            const schemaSql = fs.readFileSync(schemaPath, 'utf8');
                            console.log(`[Schema] 📏 Schema SQL length: ${schemaSql.length} characters`);
                            await client.query('BEGIN');
                            console.log('[Schema] 🔄 Executing schema.sql...');
                            await client.query(schemaSql);
                            await client.query('COMMIT');
                            console.log('[Schema] ✅ Tables recreated successfully from schema.sql');
                        } else {
                            console.error('[Schema] ❌ schema.sql not found!');
                            throw new Error('schema.sql file not found');
                        }
                    } catch (cleanError) {
                        await client.query('ROLLBACK');
                        console.error('[Schema] ❌ Error cleaning/recreating:', cleanError.message);
                        console.error('[Schema] Stack trace:', cleanError.stack);
                        throw cleanError; // Re-throw para que se vea en los logs
                    }
                } else {
                    console.error('[Schema] ❌ Clean script not found: migrations/999_clean_user_data.sql');
                }
            } else {
                console.log('[Schema] ℹ️  Database clean skipped (CLEAN_DATABASE_ON_START not set to "true")');
            }

            // Patch: Add unit_abbreviation to repartidor_assignments if missing
            const checkRepartidorAssignmentsTable = await client.query(`
                SELECT EXISTS (
                    SELECT FROM information_schema.tables
                    WHERE table_name = 'repartidor_assignments'
                )
            `);

            if (checkRepartidorAssignmentsTable.rows[0].exists) {
                const checkUnitAbbreviation = await client.query(`
                    SELECT column_name
                    FROM information_schema.columns
                    WHERE table_name = 'repartidor_assignments'
                    AND column_name = 'unit_abbreviation'
                `);

                if (checkUnitAbbreviation.rows.length === 0) {
                    console.log('[Schema] 📝 Adding missing column: repartidor_assignments.unit_abbreviation');
                    await client.query(`
                        ALTER TABLE repartidor_assignments
                        ADD COLUMN unit_abbreviation VARCHAR(10) DEFAULT 'kg'
                    `);
                    // Backfill existing records
                    await client.query(`
                        UPDATE repartidor_assignments
                        SET unit_abbreviation = 'kg'
                        WHERE unit_abbreviation IS NULL
                    `);
                    console.log('[Schema] ✅ Column repartidor_assignments.unit_abbreviation added successfully');
                }

                // Patch: Add product tracking columns to repartidor_assignments
                const checkProductId = await client.query(`
                    SELECT column_name
                    FROM information_schema.columns
                    WHERE table_name = 'repartidor_assignments'
                    AND column_name = 'product_id'
                `);

                if (checkProductId.rows.length === 0) {
                    console.log('[Schema] 📝 Adding product tracking columns to repartidor_assignments...');
                    await client.query(`
                        ALTER TABLE repartidor_assignments
                        ADD COLUMN IF NOT EXISTS product_id INTEGER,
                        ADD COLUMN IF NOT EXISTS product_name VARCHAR(200),
                        ADD COLUMN IF NOT EXISTS venta_detalle_id INTEGER
                    `);
                    await client.query(`
                        CREATE INDEX IF NOT EXISTS idx_repartidor_assignments_product_id
                        ON repartidor_assignments(product_id)
                    `);
                    console.log('[Schema] ✅ Product tracking columns added to repartidor_assignments');
                }

                // Patch: Add payment tracking columns to repartidor_assignments (for Mixto payments)
                const checkPaymentMethodId = await client.query(`
                    SELECT column_name
                    FROM information_schema.columns
                    WHERE table_name = 'repartidor_assignments'
                    AND column_name = 'payment_method_id'
                `);

                if (checkPaymentMethodId.rows.length === 0) {
                    console.log('[Schema] 📝 Adding payment tracking columns to repartidor_assignments...');
                    await client.query(`
                        ALTER TABLE repartidor_assignments
                        ADD COLUMN IF NOT EXISTS payment_method_id INTEGER,
                        ADD COLUMN IF NOT EXISTS cash_amount DECIMAL(12, 2),
                        ADD COLUMN IF NOT EXISTS card_amount DECIMAL(12, 2),
                        ADD COLUMN IF NOT EXISTS credit_amount DECIMAL(12, 2),
                        ADD COLUMN IF NOT EXISTS amount_received DECIMAL(12, 2),
                        ADD COLUMN IF NOT EXISTS is_credit BOOLEAN DEFAULT FALSE,
                        ADD COLUMN IF NOT EXISTS payment_reference VARCHAR(255),
                        ADD COLUMN IF NOT EXISTS liquidated_by_employee_id INTEGER
                    `);
                    await client.query(`
                        CREATE INDEX IF NOT EXISTS idx_repartidor_assignments_payment_method
                        ON repartidor_assignments(payment_method_id)
                    `);
                    await client.query(`
                        CREATE INDEX IF NOT EXISTS idx_repartidor_assignments_liquidated_by
                        ON repartidor_assignments(liquidated_by_employee_id)
                    `);
                    // Backfill existing liquidated assignments with cash payment
                    console.log('[Schema] 📝 Backfilling existing liquidated assignments with cash payment...');
                    await client.query(`
                        WITH assignment_net AS (
                            SELECT
                                ra.id,
                                ra.assigned_amount,
                                COALESCE(SUM(rr.amount), 0) as returned_amount,
                                (ra.assigned_amount - COALESCE(SUM(rr.amount), 0)) as net_amount
                            FROM repartidor_assignments ra
                            LEFT JOIN repartidor_returns rr ON rr.assignment_id = ra.id
                              AND (rr.status IS NULL OR rr.status != 'deleted')
                            WHERE ra.status = 'liquidated'
                              AND ra.payment_method_id IS NULL
                            GROUP BY ra.id, ra.assigned_amount
                        )
                        UPDATE repartidor_assignments ra
                        SET
                            payment_method_id = 1,
                            cash_amount = an.net_amount,
                            card_amount = 0,
                            credit_amount = 0,
                            amount_received = an.net_amount,
                            is_credit = FALSE
                        FROM assignment_net an
                        WHERE ra.id = an.id
                    `);
                    console.log('[Schema] ✅ Payment tracking columns added to repartidor_assignments');
                }

                // Patch: Make venta_id nullable for direct assignments (without sale)
                // Also make terminal_id and local_op_seq nullable for mobile-created assignments
                const checkVentaIdNotNull = await client.query(`
                    SELECT is_nullable
                    FROM information_schema.columns
                    WHERE table_name = 'repartidor_assignments'
                    AND column_name = 'venta_id'
                `);

                if (checkVentaIdNotNull.rows.length > 0 && checkVentaIdNotNull.rows[0].is_nullable === 'NO') {
                    console.log('[Schema] 📝 Making venta_id nullable for direct assignments...');
                    await client.query(`
                        ALTER TABLE repartidor_assignments
                        ALTER COLUMN venta_id DROP NOT NULL
                    `);
                    console.log('[Schema] ✅ repartidor_assignments.venta_id is now nullable');
                }

                // Make terminal_id nullable for mobile assignments
                const checkTerminalIdNotNull = await client.query(`
                    SELECT is_nullable
                    FROM information_schema.columns
                    WHERE table_name = 'repartidor_assignments'
                    AND column_name = 'terminal_id'
                `);

                if (checkTerminalIdNotNull.rows.length > 0 && checkTerminalIdNotNull.rows[0].is_nullable === 'NO') {
                    console.log('[Schema] 📝 Making terminal_id nullable for mobile assignments...');
                    await client.query(`
                        ALTER TABLE repartidor_assignments
                        ALTER COLUMN terminal_id DROP NOT NULL
                    `);
                    console.log('[Schema] ✅ repartidor_assignments.terminal_id is now nullable');
                }

                // Make local_op_seq nullable for mobile assignments
                const checkLocalOpSeqNotNull = await client.query(`
                    SELECT is_nullable
                    FROM information_schema.columns
                    WHERE table_name = 'repartidor_assignments'
                    AND column_name = 'local_op_seq'
                `);

                if (checkLocalOpSeqNotNull.rows.length > 0 && checkLocalOpSeqNotNull.rows[0].is_nullable === 'NO') {
                    console.log('[Schema] 📝 Making local_op_seq nullable for mobile assignments...');
                    await client.query(`
                        ALTER TABLE repartidor_assignments
                        ALTER COLUMN local_op_seq DROP NOT NULL
                    `);
                    console.log('[Schema] ✅ repartidor_assignments.local_op_seq is now nullable');
                }

                // Make created_local_utc nullable for mobile assignments
                const checkCreatedLocalUtcNotNull = await client.query(`
                    SELECT is_nullable
                    FROM information_schema.columns
                    WHERE table_name = 'repartidor_assignments'
                    AND column_name = 'created_local_utc'
                `);

                if (checkCreatedLocalUtcNotNull.rows.length > 0 && checkCreatedLocalUtcNotNull.rows[0].is_nullable === 'NO') {
                    console.log('[Schema] 📝 Making created_local_utc nullable for mobile assignments...');
                    await client.query(`
                        ALTER TABLE repartidor_assignments
                        ALTER COLUMN created_local_utc DROP NOT NULL
                    `);
                    console.log('[Schema] ✅ repartidor_assignments.created_local_utc is now nullable');
                }
            }

            // Patch: Add expense review tracking columns to expenses table
            const checkExpensesTable = await client.query(`
                SELECT EXISTS (
                    SELECT FROM information_schema.tables
                    WHERE table_name = 'expenses'
                )
            `);

            if (checkExpensesTable.rows[0].exists) {
                // Add reviewed_by_employee_id if missing
                const checkReviewedByEmployee = await client.query(`
                    SELECT column_name
                    FROM information_schema.columns
                    WHERE table_name = 'expenses'
                    AND column_name = 'reviewed_by_employee_id'
                `);

                if (checkReviewedByEmployee.rows.length === 0) {
                    console.log('[Schema] 📝 Adding missing column: expenses.reviewed_by_employee_id');
                    await client.query(`
                        ALTER TABLE expenses
                        ADD COLUMN reviewed_by_employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL
                    `);
                    console.log('[Schema] ✅ Column expenses.reviewed_by_employee_id added successfully');
                }

                // Add reviewed_at if missing
                const checkReviewedAt = await client.query(`
                    SELECT column_name
                    FROM information_schema.columns
                    WHERE table_name = 'expenses'
                    AND column_name = 'reviewed_at'
                `);

                if (checkReviewedAt.rows.length === 0) {
                    console.log('[Schema] 📝 Adding missing column: expenses.reviewed_at');
                    await client.query(`
                        ALTER TABLE expenses
                        ADD COLUMN reviewed_at TIMESTAMP
                    `);
                    console.log('[Schema] ✅ Column expenses.reviewed_at added successfully');
                }
            }

            // Patch: Create global_expense_categories table if not exists
            const checkGlobalCategories = await client.query(`
                SELECT EXISTS (
                    SELECT FROM information_schema.tables
                    WHERE table_name = 'global_expense_categories'
                )
            `);

            if (!checkGlobalCategories.rows[0].exists) {
                console.log('[Schema] 📝 Creating global_expense_categories table...');
                await client.query(`
                    CREATE TABLE IF NOT EXISTS global_expense_categories (
                        id INTEGER PRIMARY KEY,
                        name VARCHAR(100) NOT NULL UNIQUE,
                        description TEXT,
                        is_measurable BOOLEAN DEFAULT FALSE,
                        unit_abbreviation VARCHAR(10),
                        is_available BOOLEAN DEFAULT TRUE,
                        sort_order INTEGER DEFAULT 0,
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    )
                `);

                // Insert canonical categories with IDs 1-14
                await client.query(`
                    INSERT INTO global_expense_categories (id, name, description, is_measurable, unit_abbreviation, sort_order)
                    VALUES
                        (1, 'Maíz / Maseca / Harina', 'Materias primas', TRUE, 'kg', 1),
                        (2, 'Gas LP', 'Gas para producción', TRUE, 'L', 2),
                        (3, 'Combustible Vehículos', 'Gasolina/Diésel para reparto', TRUE, 'L', 3),
                        (4, 'Consumibles (Papel, Bolsas)', 'Materiales empaque', FALSE, NULL, 4),
                        (5, 'Refacciones Moto', 'Refacciones moto', FALSE, NULL, 5),
                        (6, 'Refacciones Auto', 'Refacciones auto', FALSE, NULL, 6),
                        (7, 'Mantenimiento Maquinaria', 'Mantenimiento equipo', FALSE, NULL, 7),
                        (8, 'Sueldos y Salarios', 'Nómina', FALSE, NULL, 8),
                        (9, 'Impuestos (ISR, IVA)', 'Obligaciones fiscales', FALSE, NULL, 9),
                        (10, 'Servicios (Luz, Agua, Teléfono)', 'Servicios públicos', FALSE, NULL, 10),
                        (11, 'Limpieza', 'Materiales limpieza', FALSE, NULL, 11),
                        (12, 'Otros Gastos', 'No clasificados', FALSE, NULL, 12),
                        (13, 'Comida', 'Viáticos y alimentación', FALSE, NULL, 13),
                        (14, 'Otros', 'Otros gastos', FALSE, NULL, 14)
                    ON CONFLICT (id) DO NOTHING
                `);

                console.log('[Schema] ✅ global_expense_categories table created with canonical IDs 1-14');
            }

            // Patch: Add global_category_id to expenses if missing
            if (checkExpensesTable.rows[0].exists) {
                const checkGlobalCategoryId = await client.query(`
                    SELECT column_name
                    FROM information_schema.columns
                    WHERE table_name = 'expenses'
                    AND column_name = 'global_category_id'
                `);

                if (checkGlobalCategoryId.rows.length === 0) {
                    console.log('[Schema] 📝 Adding expenses.global_category_id column...');
                    await client.query(`
                        ALTER TABLE expenses
                        ADD COLUMN global_category_id INTEGER REFERENCES global_expense_categories(id)
                    `);
                    console.log('[Schema] ✅ Column expenses.global_category_id added');
                }
            }

            // Patch: Add unidad_venta to productos if missing
            const checkProductosTable = await client.query(`
                SELECT EXISTS (
                    SELECT FROM information_schema.tables
                    WHERE table_name = 'productos'
                )
            `);

            if (checkProductosTable.rows[0].exists) {
                const checkUnidadVenta = await client.query(`
                    SELECT column_name
                    FROM information_schema.columns
                    WHERE table_name = 'productos'
                    AND column_name = 'unidad_venta'
                `);

                if (checkUnidadVenta.rows.length === 0) {
                    console.log('[Schema] 📝 Adding productos.unidad_venta column...');
                    await client.query(`
                        ALTER TABLE productos
                        ADD COLUMN unidad_venta VARCHAR(20) DEFAULT 'kg'
                    `);
                    console.log('[Schema] ✅ Column productos.unidad_venta added');
                }
            }

            // Patch: Create notification_preferences table if missing
            console.log('[Schema] 🔍 Checking notification_preferences table...');
            const checkNotificationPrefsTable = await client.query(`
                SELECT EXISTS (
                    SELECT FROM information_schema.tables
                    WHERE table_name = 'notification_preferences'
                )
            `);

            if (!checkNotificationPrefsTable.rows[0].exists) {
                console.log('[Schema] 📝 Creating table: notification_preferences');
                await client.query(`
                    CREATE TABLE notification_preferences (
                        id SERIAL PRIMARY KEY,
                        tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
                        employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
                        notify_login BOOLEAN DEFAULT true,
                        notify_shift_start BOOLEAN DEFAULT true,
                        notify_shift_end BOOLEAN DEFAULT true,
                        notify_expense_created BOOLEAN DEFAULT true,
                        notify_assignment_created BOOLEAN DEFAULT true,
                        notify_guardian_peso_no_registrado BOOLEAN DEFAULT true,
                        notify_guardian_operacion_irregular BOOLEAN DEFAULT true,
                        notify_guardian_discrepancia BOOLEAN DEFAULT true,
                        created_at TIMESTAMPTZ DEFAULT NOW(),
                        updated_at TIMESTAMPTZ DEFAULT NOW(),
                        UNIQUE(tenant_id, employee_id)
                    )
                `);
                await client.query(`CREATE INDEX IF NOT EXISTS idx_notification_preferences_employee ON notification_preferences(employee_id)`);
                await client.query(`CREATE INDEX IF NOT EXISTS idx_notification_preferences_tenant ON notification_preferences(tenant_id)`);
                console.log('[Schema] ✅ Table notification_preferences created successfully');
            }

            // Patch: Add offline-first columns to productos table
            console.log('[Schema] 🔍 Checking productos offline-first columns...');
            const checkProductosTerminalId = await client.query(`
                SELECT column_name FROM information_schema.columns
                WHERE table_name = 'productos' AND column_name = 'terminal_id'
            `);

            if (checkProductosTerminalId.rows.length === 0) {
                console.log('[Schema] 📝 Adding offline-first columns to productos table...');
                await client.query(`ALTER TABLE productos ADD COLUMN IF NOT EXISTS terminal_id VARCHAR(255)`);
                await client.query(`ALTER TABLE productos ADD COLUMN IF NOT EXISTS local_op_seq INTEGER`);
                await client.query(`ALTER TABLE productos ADD COLUMN IF NOT EXISTS created_local_utc TEXT`);
                await client.query(`ALTER TABLE productos ADD COLUMN IF NOT EXISTS device_event_raw BIGINT`);
                await client.query(`ALTER TABLE productos ADD COLUMN IF NOT EXISTS last_modified_local_utc TEXT`);
                await client.query(`ALTER TABLE productos ADD COLUMN IF NOT EXISTS needs_update BOOLEAN DEFAULT FALSE`);
                await client.query(`ALTER TABLE productos ADD COLUMN IF NOT EXISTS needs_delete BOOLEAN DEFAULT FALSE`);
                await client.query(`CREATE INDEX IF NOT EXISTS idx_productos_needs_sync ON productos(tenant_id, needs_update) WHERE needs_update = TRUE OR needs_delete = TRUE`);
                console.log('[Schema] ✅ Productos offline-first columns added');
            }

            // Patch: Create units_of_measure table if missing
            console.log('[Schema] 🔍 Checking units_of_measure table...');
            const checkUnitsTable = await client.query(`
                SELECT EXISTS (
                    SELECT FROM information_schema.tables
                    WHERE table_name = 'units_of_measure'
                )
            `);

            if (!checkUnitsTable.rows[0].exists) {
                console.log('[Schema] 📝 Creating table: units_of_measure');
                await client.query(`
                    CREATE TABLE units_of_measure (
                        id SERIAL PRIMARY KEY,
                        name VARCHAR(100) NOT NULL,
                        abbreviation VARCHAR(20) NOT NULL UNIQUE
                    )
                `);
                // Seed with common units
                await client.query(`
                    INSERT INTO units_of_measure (name, abbreviation) VALUES
                    ('Kilogramo', 'kg'),
                    ('Litro', 'L'),
                    ('Pieza', 'pz'),
                    ('Unidad', 'u'),
                    ('Gramo', 'g'),
                    ('Mililitro', 'ml')
                    ON CONFLICT (abbreviation) DO NOTHING
                `);
                console.log('[Schema] ✅ Table units_of_measure created with seed data');
            }

            // Patch: Create productos_branch_precios table if missing (branch-specific pricing)
            console.log('[Schema] 🔍 Checking productos_branch_precios table...');
            const checkProductosBranchPreciosTable = await client.query(`
                SELECT EXISTS (
                    SELECT FROM information_schema.tables
                    WHERE table_name = 'productos_branch_precios'
                )
            `);

            if (!checkProductosBranchPreciosTable.rows[0].exists) {
                console.log('[Schema] 📝 Creating table: productos_branch_precios (precios por sucursal)');
                await client.query(`
                    CREATE TABLE productos_branch_precios (
                        id SERIAL PRIMARY KEY,
                        tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
                        branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
                        producto_id INTEGER NOT NULL REFERENCES productos(id) ON DELETE CASCADE,
                        precio_venta NUMERIC(10,2) NOT NULL,
                        precio_compra NUMERIC(10,2),
                        global_id VARCHAR(255) UNIQUE NOT NULL,
                        terminal_id VARCHAR(255),
                        local_op_seq INTEGER,
                        created_local_utc TEXT,
                        last_modified_local_utc TEXT,
                        eliminado BOOLEAN DEFAULT FALSE,
                        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        UNIQUE(tenant_id, branch_id, producto_id)
                    )
                `);
                await client.query(`CREATE INDEX IF NOT EXISTS idx_productos_branch_precios_lookup ON productos_branch_precios(tenant_id, branch_id, producto_id) WHERE eliminado = FALSE`);
                await client.query(`CREATE INDEX IF NOT EXISTS idx_productos_branch_precios_global_id ON productos_branch_precios(global_id)`);
                console.log('[Schema] ✅ Table productos_branch_precios created successfully');
            }

            // Patch: Add sync_version and has_conflict columns to purchases for conflict detection
            if (checkPurchasesTable.rows[0].exists) {
                const checkSyncVersion = await client.query(`
                    SELECT column_name
                    FROM information_schema.columns
                    WHERE table_name = 'purchases'
                    AND column_name = 'sync_version'
                `);

                if (checkSyncVersion.rows.length === 0) {
                    console.log('[Schema] 📝 Adding sync_version and has_conflict columns to purchases...');
                    await client.query(`
                        ALTER TABLE purchases
                        ADD COLUMN IF NOT EXISTS sync_version INTEGER DEFAULT 1,
                        ADD COLUMN IF NOT EXISTS has_conflict BOOLEAN DEFAULT FALSE
                    `);

                    // Create trigger to auto-increment sync_version on updates
                    await client.query(`
                        CREATE OR REPLACE FUNCTION increment_purchase_sync_version()
                        RETURNS TRIGGER AS $$
                        BEGIN
                            IF OLD.updated_at IS DISTINCT FROM NEW.updated_at THEN
                                NEW.sync_version := COALESCE(OLD.sync_version, 0) + 1;
                            END IF;
                            RETURN NEW;
                        END;
                        $$ LANGUAGE plpgsql
                    `);

                    await client.query(`
                        DROP TRIGGER IF EXISTS trg_purchases_sync_version ON purchases
                    `);
                    await client.query(`
                        CREATE TRIGGER trg_purchases_sync_version
                        BEFORE UPDATE ON purchases
                        FOR EACH ROW
                        EXECUTE FUNCTION increment_purchase_sync_version()
                    `);

                    console.log('[Schema] ✅ Purchases sync_version and has_conflict columns added with trigger');
                }
            }

            // Patch: Add offline-first columns to suppliers table
            const checkSuppliersTable = await client.query(`
                SELECT EXISTS (
                    SELECT FROM information_schema.tables
                    WHERE table_name = 'suppliers'
                )
            `);

            if (checkSuppliersTable.rows[0].exists) {
                const checkSuppliersGlobalId = await client.query(`
                    SELECT column_name
                    FROM information_schema.columns
                    WHERE table_name = 'suppliers'
                    AND column_name = 'global_id'
                `);

                if (checkSuppliersGlobalId.rows.length === 0) {
                    console.log('[Schema] 📝 Adding offline-first columns to suppliers...');
                    await client.query(`
                        ALTER TABLE suppliers
                        ADD COLUMN IF NOT EXISTS global_id UUID,
                        ADD COLUMN IF NOT EXISTS terminal_id VARCHAR(50),
                        ADD COLUMN IF NOT EXISTS local_op_seq INTEGER DEFAULT 0,
                        ADD COLUMN IF NOT EXISTS created_local_utc TIMESTAMP,
                        ADD COLUMN IF NOT EXISTS last_modified_local_utc TIMESTAMP,
                        ADD COLUMN IF NOT EXISTS is_undeletable BOOLEAN DEFAULT FALSE,
                        ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT FALSE,
                        ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP,
                        ADD COLUMN IF NOT EXISTS contact_person VARCHAR(255)
                    `);

                    // Create unique index on global_id
                    await client.query(`
                        CREATE UNIQUE INDEX IF NOT EXISTS idx_suppliers_global_id ON suppliers(global_id) WHERE global_id IS NOT NULL
                    `);

                    console.log('[Schema] ✅ Suppliers offline-first columns added');
                }
            }

            // Patch: Create branch_devices table for Primary/Auxiliar device management
            console.log('[Schema] 🔍 Checking branch_devices table...');
            const checkBranchDevicesTable = await client.query(`
                SELECT EXISTS (
                    SELECT FROM information_schema.tables
                    WHERE table_name = 'branch_devices'
                )
            `);

            if (!checkBranchDevicesTable.rows[0].exists) {
                console.log('[Schema] 📝 Creating table: branch_devices (Primary/Auxiliar device management)');
                await client.query(`
                    CREATE TABLE branch_devices (
                        id SERIAL PRIMARY KEY,
                        tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
                        branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
                        device_id VARCHAR(255) NOT NULL,
                        device_name VARCHAR(255),
                        device_type VARCHAR(50),
                        is_primary BOOLEAN DEFAULT FALSE,
                        claimed_at TIMESTAMPTZ,
                        last_seen_at TIMESTAMPTZ,
                        employee_id INTEGER REFERENCES employees(id),
                        created_at TIMESTAMPTZ DEFAULT NOW(),
                        updated_at TIMESTAMPTZ DEFAULT NOW()
                    )
                `);
                // Create indexes
                await client.query(`
                    CREATE UNIQUE INDEX IF NOT EXISTS idx_branch_devices_unique
                    ON branch_devices(device_id, branch_id, tenant_id)
                `);
                await client.query(`
                    CREATE INDEX IF NOT EXISTS idx_branch_devices_branch
                    ON branch_devices(branch_id, tenant_id)
                `);
                await client.query(`
                    CREATE INDEX IF NOT EXISTS idx_branch_devices_primary
                    ON branch_devices(branch_id, tenant_id) WHERE is_primary = TRUE
                `);
                // Create trigger for updated_at
                await client.query(`
                    CREATE OR REPLACE FUNCTION update_branch_devices_updated_at()
                    RETURNS TRIGGER AS $$
                    BEGIN
                        NEW.updated_at = NOW();
                        RETURN NEW;
                    END;
                    $$ LANGUAGE plpgsql
                `);
                await client.query(`
                    DROP TRIGGER IF EXISTS trigger_branch_devices_updated_at ON branch_devices
                `);
                await client.query(`
                    CREATE TRIGGER trigger_branch_devices_updated_at
                    BEFORE UPDATE ON branch_devices
                    FOR EACH ROW
                    EXECUTE FUNCTION update_branch_devices_updated_at()
                `);
                console.log('[Schema] ✅ Table branch_devices created successfully');
            }

            // Patch: Migrate to tenant-specific roles (Migration 014)
            // Check if roles table has tenant_id column (new structure)
            const checkRolesTenantId = await client.query(`
                SELECT column_name
                FROM information_schema.columns
                WHERE table_name = 'roles'
                AND column_name = 'tenant_id'
            `);

            if (checkRolesTenantId.rows.length === 0) {
                console.log('[Schema] 📝 Migrating roles to tenant-specific structure (Migration 014)...');

                // Step 1: Drop FK constraints
                await client.query(`ALTER TABLE employees DROP CONSTRAINT IF EXISTS fk_employees_role_id`);
                await client.query(`ALTER TABLE role_permissions DROP CONSTRAINT IF EXISTS role_permissions_role_id_fkey`);

                // Step 2: Backup current employees role_id mapping (old global role_id → role name)
                await client.query(`
                    CREATE TEMP TABLE employee_role_backup AS
                    SELECT e.id as employee_id, e.tenant_id, e.role_id as old_role_id,
                           CASE
                               WHEN e.role_id = 1 THEN 'Administrador'
                               WHEN e.role_id = 2 THEN 'Encargado'
                               WHEN e.role_id = 3 THEN 'Repartidor'
                               WHEN e.role_id = 4 THEN 'Ayudante'
                               ELSE 'Ayudante'
                           END as role_name
                    FROM employees e
                `);

                // Step 3: Drop and recreate roles table with tenant structure
                await client.query(`DROP TABLE IF EXISTS roles CASCADE`);
                await client.query(`
                    CREATE TABLE roles (
                        id SERIAL PRIMARY KEY,
                        tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
                        name VARCHAR(255) NOT NULL,
                        description TEXT,
                        is_system BOOLEAN DEFAULT false,
                        mobile_access_type VARCHAR(50) DEFAULT 'none',
                        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                        UNIQUE(tenant_id, name)
                    )
                `);
                await client.query(`CREATE INDEX IF NOT EXISTS idx_roles_tenant ON roles(tenant_id)`);
                await client.query(`CREATE INDEX IF NOT EXISTS idx_roles_is_system ON roles(is_system)`);

                // Step 4: Insert default roles for each existing tenant
                await client.query(`
                    INSERT INTO roles (tenant_id, name, description, is_system, mobile_access_type)
                    SELECT
                        t.id,
                        r.name,
                        r.description,
                        true,
                        CASE
                            WHEN r.name IN ('Administrador', 'Encargado') THEN 'admin'
                            WHEN r.name = 'Repartidor' THEN 'distributor'
                            ELSE 'none'
                        END
                    FROM tenants t
                    CROSS JOIN (
                        VALUES
                            ('Administrador', 'Acceso total al sistema'),
                            ('Encargado', 'Gerente de turno - permisos extensos'),
                            ('Repartidor', 'Acceso limitado como repartidor'),
                            ('Ayudante', 'Soporte - acceso limitado')
                    ) AS r(name, description)
                `);

                // Step 5: Update employees with new tenant-specific role_id
                await client.query(`
                    UPDATE employees e
                    SET role_id = r.id
                    FROM employee_role_backup erb
                    JOIN roles r ON r.tenant_id = erb.tenant_id AND r.name = erb.role_name
                    WHERE e.id = erb.employee_id
                `);

                // Step 6: Re-add FK constraint
                await client.query(`
                    ALTER TABLE employees ADD CONSTRAINT fk_employees_role_id
                    FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE SET NULL
                `);

                // Step 7: Recreate role_permissions with new FK and seed permissions
                await client.query(`
                    INSERT INTO role_permissions (role_id, permission_id)
                    SELECT r.id, p.id
                    FROM roles r
                    JOIN permissions p ON
                        (r.mobile_access_type = 'admin' AND p.code = 'AccessMobileAppAsAdmin')
                        OR (r.mobile_access_type = 'distributor' AND p.code = 'AccessMobileAppAsDistributor')
                    WHERE r.mobile_access_type != 'none'
                    ON CONFLICT DO NOTHING
                `);

                // Step 8: Create trigger to seed roles for new tenants
                await client.query(`
                    CREATE OR REPLACE FUNCTION seed_default_roles_for_tenant()
                    RETURNS TRIGGER AS $$
                    BEGIN
                        INSERT INTO roles (tenant_id, name, description, is_system, mobile_access_type)
                        VALUES
                            (NEW.id, 'Administrador', 'Acceso total al sistema', true, 'admin'),
                            (NEW.id, 'Encargado', 'Gerente de turno - permisos extensos', true, 'admin'),
                            (NEW.id, 'Repartidor', 'Acceso limitado como repartidor', true, 'distributor'),
                            (NEW.id, 'Ayudante', 'Soporte - acceso limitado', true, 'none');

                        INSERT INTO role_permissions (role_id, permission_id)
                        SELECT r.id, p.id
                        FROM roles r
                        JOIN permissions p ON
                            (r.mobile_access_type = 'admin' AND p.code = 'AccessMobileAppAsAdmin')
                            OR (r.mobile_access_type = 'distributor' AND p.code = 'AccessMobileAppAsDistributor')
                        WHERE r.tenant_id = NEW.id AND r.mobile_access_type != 'none';

                        RETURN NEW;
                    END;
                    $$ LANGUAGE plpgsql
                `);

                await client.query(`DROP TRIGGER IF EXISTS trigger_seed_tenant_roles ON tenants`);
                await client.query(`
                    CREATE TRIGGER trigger_seed_tenant_roles
                    AFTER INSERT ON tenants
                    FOR EACH ROW
                    EXECUTE FUNCTION seed_default_roles_for_tenant()
                `);

                // Step 9: Create updated_at trigger for roles
                await client.query(`
                    CREATE OR REPLACE FUNCTION update_roles_updated_at()
                    RETURNS TRIGGER AS $$
                    BEGIN
                        NEW.updated_at = CURRENT_TIMESTAMP;
                        RETURN NEW;
                    END;
                    $$ LANGUAGE plpgsql
                `);

                await client.query(`DROP TRIGGER IF EXISTS trigger_roles_updated_at ON roles`);
                await client.query(`
                    CREATE TRIGGER trigger_roles_updated_at
                    BEFORE UPDATE ON roles
                    FOR EACH ROW
                    EXECUTE FUNCTION update_roles_updated_at()
                `);

                // Step 10: Cleanup
                await client.query(`DROP TABLE IF EXISTS employee_role_backup`);

                console.log('[Schema] ✅ Roles migrated to tenant-specific structure successfully');
                console.log('[Schema] ℹ️  Each tenant now has their own Administrador, Encargado, Repartidor, Ayudante roles');
            }

            // Patch: Add offline-first columns to roles table (Migration 015)
            const checkRolesGlobalId = await client.query(`
                SELECT column_name
                FROM information_schema.columns
                WHERE table_name = 'roles'
                AND column_name = 'global_id'
            `);

            if (checkRolesGlobalId.rows.length === 0) {
                console.log('[Schema] 📝 Adding offline-first columns to roles table (Migration 015)...');

                await client.query(`
                    ALTER TABLE roles
                    ADD COLUMN IF NOT EXISTS global_id VARCHAR(36) UNIQUE,
                    ADD COLUMN IF NOT EXISTS terminal_id VARCHAR(64),
                    ADD COLUMN IF NOT EXISTS local_op_seq BIGINT DEFAULT 0,
                    ADD COLUMN IF NOT EXISTS created_local_utc TEXT
                `);

                await client.query(`CREATE INDEX IF NOT EXISTS idx_roles_global_id ON roles(global_id)`);

                console.log('[Schema] ✅ Offline-first columns added to roles table');
            }

            // Patch: Increase phone_number column size (was VARCHAR(20), now VARCHAR(50))
            // Fix for: "value too long for type character varying(50)" error in suppliers sync
            if (checkSuppliersTable.rows[0].exists) {
                console.log('[Schema] 🔍 Checking phone_number column size in suppliers...');
                const checkPhoneColumnType = await client.query(`
                    SELECT character_maximum_length
                    FROM information_schema.columns
                    WHERE table_name = 'suppliers'
                    AND column_name = 'phone_number'
                `);

                if (checkPhoneColumnType.rows.length > 0) {
                    const currentLength = checkPhoneColumnType.rows[0].character_maximum_length;
                    if (currentLength && currentLength < 50) {
                        console.log(`[Schema] 📝 Increasing suppliers.phone_number from VARCHAR(${currentLength}) to VARCHAR(50)...`);
                        await client.query(`
                            ALTER TABLE suppliers
                            ALTER COLUMN phone_number TYPE VARCHAR(50)
                        `);
                        console.log('[Schema] ✅ suppliers.phone_number column size increased');
                    }
                }
            }

            // Patch: Create preparation_mode_logs table if missing (Migration 017)
            // This table logs activation/deactivation of "Modo Preparación" for Guardian auditing
            console.log('[Schema] 🔍 Checking preparation_mode_logs table...');
            const checkPrepModeLogsTable = await client.query(`
                SELECT EXISTS (
                    SELECT FROM information_schema.tables
                    WHERE table_name = 'preparation_mode_logs'
                )
            `);

            if (!checkPrepModeLogsTable.rows[0].exists) {
                console.log('[Schema] 📝 Creating table: preparation_mode_logs (auditoría Modo Preparación)');
                await client.query(`
                    CREATE TABLE preparation_mode_logs (
                        id SERIAL PRIMARY KEY,
                        tenant_id INTEGER NOT NULL REFERENCES tenants(id),
                        branch_id INTEGER NOT NULL REFERENCES branches(id),
                        shift_id INTEGER REFERENCES shifts(id),
                        operator_employee_id INTEGER NOT NULL REFERENCES employees(id),
                        authorized_by_employee_id INTEGER REFERENCES employees(id),
                        activated_at TIMESTAMP WITH TIME ZONE NOT NULL,
                        deactivated_at TIMESTAMP WITH TIME ZONE,
                        duration_seconds DECIMAL(10,2),
                        reason VARCHAR(500),
                        notes TEXT,
                        was_reviewed BOOLEAN DEFAULT FALSE,
                        review_notes TEXT,
                        reviewed_at TIMESTAMP WITH TIME ZONE,
                        reviewed_by_employee_id INTEGER REFERENCES employees(id),
                        status VARCHAR(50) NOT NULL DEFAULT 'active',
                        severity VARCHAR(50) DEFAULT 'Low',
                        global_id VARCHAR(36) NOT NULL UNIQUE,
                        terminal_id VARCHAR(50),
                        local_op_seq INTEGER DEFAULT 0,
                        device_event_raw BIGINT DEFAULT 0,
                        created_local_utc TIMESTAMP WITH TIME ZONE,
                        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
                    )
                `);

                // Create indexes
                await client.query(`CREATE INDEX IF NOT EXISTS idx_prep_mode_logs_tenant ON preparation_mode_logs(tenant_id)`);
                await client.query(`CREATE INDEX IF NOT EXISTS idx_prep_mode_logs_branch ON preparation_mode_logs(branch_id)`);
                await client.query(`CREATE INDEX IF NOT EXISTS idx_prep_mode_logs_tenant_branch ON preparation_mode_logs(tenant_id, branch_id)`);
                await client.query(`CREATE INDEX IF NOT EXISTS idx_prep_mode_logs_shift ON preparation_mode_logs(shift_id)`);
                await client.query(`CREATE INDEX IF NOT EXISTS idx_prep_mode_logs_operator ON preparation_mode_logs(operator_employee_id)`);
                await client.query(`CREATE INDEX IF NOT EXISTS idx_prep_mode_logs_authorized_by ON preparation_mode_logs(authorized_by_employee_id)`);
                await client.query(`CREATE INDEX IF NOT EXISTS idx_prep_mode_logs_activated ON preparation_mode_logs(activated_at DESC)`);
                await client.query(`CREATE INDEX IF NOT EXISTS idx_prep_mode_logs_status ON preparation_mode_logs(status)`);
                await client.query(`CREATE INDEX IF NOT EXISTS idx_prep_mode_logs_severity ON preparation_mode_logs(severity)`);
                await client.query(`CREATE INDEX IF NOT EXISTS idx_prep_mode_logs_reviewed ON preparation_mode_logs(was_reviewed) WHERE was_reviewed = false`);
                await client.query(`CREATE INDEX IF NOT EXISTS idx_prep_mode_logs_global_id ON preparation_mode_logs(global_id)`);

                // Create trigger for updated_at
                await client.query(`
                    CREATE OR REPLACE FUNCTION update_preparation_mode_logs_updated_at()
                    RETURNS TRIGGER AS $$
                    BEGIN
                        NEW.updated_at = CURRENT_TIMESTAMP;
                        RETURN NEW;
                    END;
                    $$ LANGUAGE plpgsql
                `);

                await client.query(`
                    DROP TRIGGER IF EXISTS trigger_prep_mode_logs_updated_at ON preparation_mode_logs
                `);
                await client.query(`
                    CREATE TRIGGER trigger_prep_mode_logs_updated_at
                    BEFORE UPDATE ON preparation_mode_logs
                    FOR EACH ROW
                    EXECUTE FUNCTION update_preparation_mode_logs_updated_at()
                `);

                // Create trigger to calculate severity based on duration
                await client.query(`
                    CREATE OR REPLACE FUNCTION calculate_prep_mode_severity()
                    RETURNS TRIGGER AS $$
                    BEGIN
                        IF NEW.duration_seconds IS NOT NULL THEN
                            IF NEW.duration_seconds > 1800 THEN
                                NEW.severity = 'Critical';
                            ELSIF NEW.duration_seconds > 600 THEN
                                NEW.severity = 'High';
                            ELSIF NEW.duration_seconds > 180 THEN
                                NEW.severity = 'Medium';
                            ELSE
                                NEW.severity = 'Low';
                            END IF;
                        END IF;
                        RETURN NEW;
                    END;
                    $$ LANGUAGE plpgsql
                `);

                await client.query(`
                    DROP TRIGGER IF EXISTS trigger_prep_mode_severity ON preparation_mode_logs
                `);
                await client.query(`
                    CREATE TRIGGER trigger_prep_mode_severity
                    BEFORE INSERT OR UPDATE ON preparation_mode_logs
                    FOR EACH ROW
                    EXECUTE FUNCTION calculate_prep_mode_severity()
                `);

                console.log('[Schema] ✅ Table preparation_mode_logs created successfully with triggers');
            }

            // 3. Always run seeds (idempotent - uses ON CONFLICT)
            console.log('[Seeds] 📝 Running seeds.sql...');
            const seedsPath = path.join(__dirname, 'seeds.sql');
            if (fs.existsSync(seedsPath)) {
                const seedsSql = fs.readFileSync(seedsPath, 'utf8');
                await client.query('BEGIN');
                await client.query(seedsSql);
                await client.query('COMMIT');
                console.log('[Seeds] ✅ Seeds applied successfully');
            } else {
                console.error('[Seeds] ❌ seeds.sql not found!');
            }

            console.log('[Schema] ✅ Database initialization complete');

        } finally {
            client.release();
        }
    } catch (error) {
        console.error('[Schema] ❌ Error initializing database:', error.message);
        console.error(error.stack);
        // Don't throw - let server start even if initialization fails
    }
}

// 🌍 WRAPPER: Ensure timezone is UTC for EVERY database operation
// This wrapper intercepts all queries and ensures UTC timezone by beginning each session with SET timezone
class UTCPoolWrapper {
    constructor(pgPool) {
        this.pool = pgPool;
    }

    // For queries that don't need a persistent connection
    async query(text, values) {
        const client = await this.pool.connect();
        try {
            // CRITICAL: Set timezone to UTC before executing ANY query
            await client.query("SET timezone = 'UTC'");
            return await client.query(text, values);
        } finally {
            client.release();
        }
    }

    // For code that uses pool.connect() directly and needs persistent connection
    async connect() {
        const client = await this.pool.connect();
        // Set timezone once for this connection session
        try {
            await client.query("SET timezone = 'UTC'");
        } catch (error) {
            console.error('❌ Error setting timezone on connected client:', error.message);
            client.release();
            throw error;
        }

        // Optionally wrap the query method for safety
        const originalQuery = client.query.bind(client);
        client.query = function(text, values, callback) {
            // If using callback style (legacy), handle it
            if (typeof callback === 'function') {
                return originalQuery(text, values, callback);
            }
            // Modern promise-based
            return originalQuery(text, values);
        };

        return client;
    }

    // Expose other pool methods
    on(event, callback) {
        return this.pool.on(event, callback);
    }
}

// Create wrapped pool
const wrappedPool = new UTCPoolWrapper(pool);

module.exports = {
    pool: wrappedPool,
    initializeDatabase,
    runMigrations
};
