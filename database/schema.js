// ═══════════════════════════════════════════════════════════════
// DATABASE SCHEMA - Table creation (initializeDatabase)
// ═══════════════════════════════════════════════════════════════

const { rawPool: pool } = require('./pool');

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
                device_id INTEGER REFERENCES devices(id) ON DELETE CASCADE,
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

        // Tabla: categorias_productos (categorías de productos)
        await client.query(`
            CREATE TABLE IF NOT EXISTS categorias_productos (
                id SERIAL PRIMARY KEY,
                tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
                nombre VARCHAR(255) NOT NULL,
                is_available BOOLEAN DEFAULT TRUE,
                is_system_category BOOLEAN DEFAULT FALSE,
                is_deleted BOOLEAN DEFAULT FALSE,
                deleted_at TIMESTAMPTZ,
                global_id VARCHAR(255),
                terminal_id VARCHAR(255),
                local_op_seq INTEGER DEFAULT 0,
                created_local_utc TEXT,
                last_modified_local_utc TEXT,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW(),
                UNIQUE(tenant_id, global_id)
            )
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_categorias_productos_global_id
            ON categorias_productos(global_id) WHERE global_id IS NOT NULL
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_categorias_productos_tenant
            ON categorias_productos(tenant_id) WHERE is_deleted = FALSE
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

        try {
            await client.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS profile_photo_url TEXT`);
            console.log('[DB] ✅ Columna employees.profile_photo_url verificada/agregada');
        } catch (error) {
            console.log('[DB] ⚠️ employees.profile_photo_url:', error.message);
        }

        // Patch: Add missing columns to employee_branches (used by routes but missing from CREATE TABLE)
        try {
            await client.query(`ALTER TABLE employee_branches ADD COLUMN IF NOT EXISTS tenant_id INTEGER REFERENCES tenants(id)`);
            await client.query(`ALTER TABLE employee_branches ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`);
            await client.query(`ALTER TABLE employee_branches ADD COLUMN IF NOT EXISTS removed_at TIMESTAMP`);
            await client.query(`ALTER TABLE employee_branches ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`);
            console.log('[DB] ✅ employee_branches columns verified');
        } catch (error) {
            console.log('[DB] ⚠️ employee_branches columns:', error.message);
        }

        // Tabla: cliente_branches (relacion muchos a muchos entre customers y branches)
        try {
            await client.query(`
                CREATE TABLE IF NOT EXISTS cliente_branches (
                    id SERIAL PRIMARY KEY,
                    tenant_id INTEGER NOT NULL REFERENCES tenants(id),
                    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
                    branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
                    is_active BOOLEAN DEFAULT true,
                    assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    removed_at TIMESTAMP,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(tenant_id, customer_id, branch_id)
                )
            `);
            await client.query(`CREATE INDEX IF NOT EXISTS idx_cliente_branches_tenant ON cliente_branches(tenant_id)`);
            await client.query(`CREATE INDEX IF NOT EXISTS idx_cliente_branches_customer ON cliente_branches(customer_id)`);
            await client.query(`CREATE INDEX IF NOT EXISTS idx_cliente_branches_branch ON cliente_branches(branch_id)`);
            console.log('[DB] ✅ Tabla cliente_branches verificada/creada');
        } catch (error) {
            console.log('[DB] ⚠️ cliente_branches:', error.message);
        }

        console.log('[DB] ✅ Database schema initialized successfully');
    } catch (error) {
        console.error('[DB] ❌ Error initializing database:', error);
        throw error;
    } finally {
        client.release();
    }
}

module.exports = { initializeDatabase };
