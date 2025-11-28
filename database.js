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
        try {
            await client.query(`
                INSERT INTO subscriptions (name, price, max_branches, max_devices, max_employees, features)
                VALUES
                    ('Basic', 0.00, 1, 3, 5, '{"guardian": true, "reports": true}'),
                    ('Pro', 499.00, 3, 10, 20, '{"guardian": true, "reports": true, "advanced_analytics": true}'),
                    ('Enterprise', 999.00, 10, 50, 100, '{"guardian": true, "reports": true, "advanced_analytics": true, "custom_features": true}')
                ON CONFLICT (name) DO NOTHING
            `);
        } catch (error) {
            console.log('[DB] ⚠️ subscriptions insert error (expected if table structure differs):', error.message);
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

        // Tabla: shift_cash_snapshot (snapshot de corte de caja para todos los roles)
        await client.query(`
            CREATE TABLE IF NOT EXISTS shift_cash_snapshot (
                id SERIAL PRIMARY KEY,
                tenant_id INTEGER NOT NULL,
                branch_id INTEGER NOT NULL,
                employee_id INTEGER NOT NULL,
                shift_id INTEGER NOT NULL,
                employee_role VARCHAR(50) NOT NULL,

                -- Montos básicos del corte de caja
                initial_amount DECIMAL(10,2) DEFAULT 0.00 NOT NULL,
                cash_sales DECIMAL(10,2) DEFAULT 0.00 NOT NULL,
                card_sales DECIMAL(10,2) DEFAULT 0.00 NOT NULL,
                credit_sales DECIMAL(10,2) DEFAULT 0.00 NOT NULL,
                cash_payments DECIMAL(10,2) DEFAULT 0.00 NOT NULL,
                card_payments DECIMAL(10,2) DEFAULT 0.00 NOT NULL,
                expenses DECIMAL(10,2) DEFAULT 0.00 NOT NULL,
                deposits DECIMAL(10,2) DEFAULT 0.00 NOT NULL,
                withdrawals DECIMAL(10,2) DEFAULT 0.00 NOT NULL,

                -- Asignaciones y devoluciones (solo para repartidores)
                total_assigned_amount DECIMAL(10,2) DEFAULT 0.00 NOT NULL,
                total_assigned_quantity DECIMAL(10,2) DEFAULT 0.00 NOT NULL,
                total_returned_amount DECIMAL(10,2) DEFAULT 0.00 NOT NULL,
                total_returned_quantity DECIMAL(10,2) DEFAULT 0.00 NOT NULL,
                net_amount_to_deliver DECIMAL(10,2) DEFAULT 0.00 NOT NULL,
                net_quantity_delivered DECIMAL(10,2) DEFAULT 0.00 NOT NULL,

                -- Liquidación
                actual_cash_delivered DECIMAL(10,2) DEFAULT 0.00 NOT NULL,
                cash_difference DECIMAL(10,2) DEFAULT 0.00 NOT NULL,

                -- Campo calculado (expected_cash) se agregará con ALTER TABLE después
                expected_cash DECIMAL(10,2),

                -- Contadores
                assignment_count INTEGER DEFAULT 0 NOT NULL,
                liquidated_assignment_count INTEGER DEFAULT 0 NOT NULL,
                return_count INTEGER DEFAULT 0 NOT NULL,
                expense_count INTEGER DEFAULT 0 NOT NULL,
                deposit_count INTEGER DEFAULT 0 NOT NULL,
                withdrawal_count INTEGER DEFAULT 0 NOT NULL,

                -- Metadata de sincronización offline-first
                last_updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
                needs_recalculation BOOLEAN DEFAULT FALSE NOT NULL,
                needs_update BOOLEAN DEFAULT FALSE NOT NULL,
                needs_deletion BOOLEAN DEFAULT FALSE NOT NULL,
                synced_at TIMESTAMPTZ,
                global_id VARCHAR(36) UNIQUE,
                terminal_id VARCHAR(100),
                created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
                updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,

                UNIQUE(shift_id)
            )
        `);

        // Índices
        await client.query('CREATE INDEX IF NOT EXISTS idx_employees_tenant_id ON employees(tenant_id)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_employees_email ON employees(email)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_devices_tenant_id ON devices(tenant_id)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_sessions_tenant_id ON sessions(tenant_id)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_branches_tenant_id ON branches(tenant_id)');

        // Índices para shift_cash_snapshot
        await client.query('CREATE INDEX IF NOT EXISTS idx_shift_cash_snapshot_shift ON shift_cash_snapshot(shift_id)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_shift_cash_snapshot_employee ON shift_cash_snapshot(employee_id)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_shift_cash_snapshot_branch ON shift_cash_snapshot(branch_id, tenant_id)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_shift_cash_snapshot_role ON shift_cash_snapshot(employee_role)');
        await client.query('CREATE INDEX IF NOT EXISTS idx_shift_cash_snapshot_needs_recalc ON shift_cash_snapshot(needs_recalculation) WHERE needs_recalculation = TRUE');
        await client.query('CREATE INDEX IF NOT EXISTS idx_shift_cash_snapshot_needs_update ON shift_cash_snapshot(needs_update) WHERE needs_update = TRUE');
        await client.query('CREATE INDEX IF NOT EXISTS idx_shift_cash_snapshot_needs_deletion ON shift_cash_snapshot(needs_deletion) WHERE needs_deletion = TRUE');
        await client.query('CREATE INDEX IF NOT EXISTS idx_shift_cash_snapshot_global_id ON shift_cash_snapshot(global_id) WHERE global_id IS NOT NULL');
        await client.query('CREATE INDEX IF NOT EXISTS idx_shift_cash_snapshot_updated_at ON shift_cash_snapshot(updated_at DESC)');

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

        // Migraciones para expenses - agregar category_id
        try {
            await client.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS category_id INTEGER REFERENCES expense_categories(id) ON DELETE SET NULL`);
            console.log('[DB] ✅ Columna expenses.category_id verificada/agregada');
        } catch (error) {
            console.log('[DB] ⚠️ expenses.category_id:', error.message);
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
                            await client.query('BEGIN');
                            await client.query(schemaSql);
                            await client.query('COMMIT');
                            console.log('[Schema] ✅ Tables recreated successfully from schema.sql');
                        } else {
                            console.error('[Schema] ❌ schema.sql not found!');
                        }
                    } catch (cleanError) {
                        console.error('[Schema] ❌ Error cleaning/recreating:', cleanError.message);
                        console.error(cleanError.stack);
                    }
                } else {
                    console.error('[Schema] ❌ Clean script not found: migrations/999_clean_user_data.sql');
                }
            } else {
                console.log('[Schema] ℹ️  Database clean skipped (CLEAN_DATABASE_ON_START not set to "true")');
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

            // 4. Create PL/pgSQL functions for shift_cash_snapshot
            console.log('[Functions] 📝 Creating cash snapshot functions...');
            try {
                // Function 1: update_shift_cash_snapshot_timestamp
                await client.query(`
                    CREATE OR REPLACE FUNCTION update_shift_cash_snapshot_timestamp()
                    RETURNS TRIGGER AS $$
                    BEGIN
                      NEW.updated_at = NOW();
                      RETURN NEW;
                    END;
                    $$ LANGUAGE plpgsql;
                `);

                // Trigger for timestamp update
                await client.query(`
                    DROP TRIGGER IF EXISTS trg_cash_snapshot_update_timestamp ON shift_cash_snapshot;
                `);
                await client.query(`
                    CREATE TRIGGER trg_cash_snapshot_update_timestamp
                    BEFORE UPDATE ON shift_cash_snapshot
                    FOR EACH ROW
                    EXECUTE FUNCTION update_shift_cash_snapshot_timestamp();
                `);

                // Function 2: recalculate_shift_cash_snapshot
                await client.query(`
                    CREATE OR REPLACE FUNCTION recalculate_shift_cash_snapshot(p_shift_id INTEGER)
                    RETURNS TABLE(
                      snapshot_id INTEGER,
                      expected_cash DECIMAL,
                      cash_sales DECIMAL,
                      total_assigned_amount DECIMAL,
                      total_returned_amount DECIMAL,
                      net_amount_to_deliver DECIMAL,
                      cash_difference DECIMAL,
                      needs_update BOOLEAN
                    ) AS $$
                    DECLARE
                      v_shift_record RECORD;
                      v_snapshot_id INTEGER;
                      v_employee_role VARCHAR(50);
                    BEGIN
                      -- Obtener información del turno y rol del empleado
                      SELECT
                        s.id,
                        s.tenant_id,
                        s.branch_id,
                        s.employee_id,
                        COALESCE(s.initial_cash, 0) as initial_amount,
                        r.name as role_name
                      INTO v_shift_record
                      FROM shifts s
                      INNER JOIN employees e ON s.employee_id = e.id
                      INNER JOIN roles r ON e.role_id = r.id
                      WHERE s.id = p_shift_id;

                      -- Si no existe el turno, salir
                      IF NOT FOUND THEN
                        RAISE EXCEPTION 'Turno % no encontrado', p_shift_id;
                      END IF;

                      v_employee_role := v_shift_record.role_name;

                      -- Solo para repartidores: calcular asignaciones y devoluciones
                      IF v_employee_role = 'repartidor' THEN
                        -- Calcular totales de asignaciones (todas, no solo liquidadas)
                        WITH assignment_totals AS (
                          SELECT
                            COUNT(*) as total_assignments,
                            COUNT(*) FILTER (WHERE ra.status = 'liquidated') as liquidated_assignments,
                            COALESCE(SUM(ra.assigned_amount), 0) as total_assigned_amt,
                            COALESCE(SUM(ra.assigned_quantity), 0) as total_assigned_qty
                          FROM repartidor_assignments ra
                          WHERE ra.repartidor_shift_id = p_shift_id
                            AND ra.status != 'cancelled'
                        ),

                        -- Calcular totales de devoluciones
                        return_totals AS (
                          SELECT
                            COUNT(*) as total_returns,
                            COALESCE(SUM(rr.amount), 0) as total_returned_amt,
                            COALESCE(SUM(rr.quantity), 0) as total_returned_qty
                          FROM repartidor_returns rr
                          INNER JOIN repartidor_assignments ra ON ra.id = rr.assignment_id
                          WHERE ra.repartidor_shift_id = p_shift_id
                        ),

                        -- Calcular neto (asignado - devuelto)
                        net_calculations AS (
                          SELECT
                            at.total_assigned_amt - COALESCE(rt.total_returned_amt, 0) as net_amt,
                            at.total_assigned_qty - COALESCE(rt.total_returned_qty, 0) as net_qty
                          FROM assignment_totals at
                          LEFT JOIN return_totals rt ON TRUE
                        ),

                        -- Calcular ventas en efectivo (asignaciones liquidadas)
                        cash_sales_calc AS (
                          SELECT
                            COALESCE(SUM(ra.assigned_amount - COALESCE(rr_sub.returned_amt, 0)), 0) as cash_sales
                          FROM repartidor_assignments ra
                          LEFT JOIN (
                            SELECT
                              rr.assignment_id,
                              SUM(rr.amount) as returned_amt
                            FROM repartidor_returns rr
                            GROUP BY rr.assignment_id
                          ) rr_sub ON rr_sub.assignment_id = ra.id
                          WHERE ra.repartidor_shift_id = p_shift_id
                            AND ra.status = 'liquidated'
                        ),

                        -- Contadores
                        counters AS (
                          SELECT
                            at.total_assignments as assignment_count,
                            at.liquidated_assignments as liquidated_assignment_count,
                            rt.total_returns as return_count,
                            0 as expense_count,
                            0 as deposit_count,
                            0 as withdrawal_count
                          FROM assignment_totals at
                          LEFT JOIN return_totals rt ON TRUE
                        )

                        -- Insertar o actualizar snapshot
                        INSERT INTO shift_cash_snapshot (
                          tenant_id,
                          branch_id,
                          employee_id,
                          shift_id,
                          employee_role,
                          initial_amount,
                          cash_sales,
                          expected_cash,
                          total_assigned_amount,
                          total_assigned_quantity,
                          total_returned_amount,
                          total_returned_quantity,
                          net_amount_to_deliver,
                          net_quantity_delivered,
                          assignment_count,
                          liquidated_assignment_count,
                          return_count,
                          needs_recalculation,
                          needs_update,
                          last_updated_at
                        )
                        SELECT
                          v_shift_record.tenant_id,
                          v_shift_record.branch_id,
                          v_shift_record.employee_id,
                          p_shift_id,
                          v_employee_role,
                          v_shift_record.initial_amount,
                          cs.cash_sales,
                          v_shift_record.initial_amount + cs.cash_sales,
                          at.total_assigned_amt,
                          at.total_assigned_qty,
                          COALESCE(rt.total_returned_amt, 0),
                          COALESCE(rt.total_returned_qty, 0),
                          nc.net_amt,
                          nc.net_qty,
                          c.assignment_count,
                          c.liquidated_assignment_count,
                          c.return_count,
                          FALSE,
                          TRUE,
                          NOW()
                        FROM assignment_totals at
                        LEFT JOIN return_totals rt ON TRUE
                        LEFT JOIN net_calculations nc ON TRUE
                        LEFT JOIN cash_sales_calc cs ON TRUE
                        LEFT JOIN counters c ON TRUE
                        ON CONFLICT (shift_id)
                        DO UPDATE SET
                          cash_sales = EXCLUDED.cash_sales,
                          expected_cash = EXCLUDED.expected_cash,
                          total_assigned_amount = EXCLUDED.total_assigned_amount,
                          total_assigned_quantity = EXCLUDED.total_assigned_quantity,
                          total_returned_amount = EXCLUDED.total_returned_amount,
                          total_returned_quantity = EXCLUDED.total_returned_quantity,
                          net_amount_to_deliver = EXCLUDED.net_amount_to_deliver,
                          net_quantity_delivered = EXCLUDED.net_quantity_delivered,
                          cash_difference = EXCLUDED.actual_cash_delivered - EXCLUDED.net_amount_to_deliver,
                          assignment_count = EXCLUDED.assignment_count,
                          liquidated_assignment_count = EXCLUDED.liquidated_assignment_count,
                          return_count = EXCLUDED.return_count,
                          needs_recalculation = FALSE,
                          needs_update = TRUE,
                          last_updated_at = NOW()
                        RETURNING id INTO v_snapshot_id;

                      ELSE
                        -- Para otros roles (cajeros, administradores): snapshot básico
                        INSERT INTO shift_cash_snapshot (
                          tenant_id,
                          branch_id,
                          employee_id,
                          shift_id,
                          employee_role,
                          initial_amount,
                          cash_sales,
                          expected_cash,
                          needs_recalculation,
                          needs_update,
                          last_updated_at
                        )
                        VALUES (
                          v_shift_record.tenant_id,
                          v_shift_record.branch_id,
                          v_shift_record.employee_id,
                          p_shift_id,
                          v_employee_role,
                          v_shift_record.initial_amount,
                          0,
                          v_shift_record.initial_amount,
                          FALSE,
                          TRUE,
                          NOW()
                        )
                        ON CONFLICT (shift_id)
                        DO UPDATE SET
                          initial_amount = EXCLUDED.initial_amount,
                          expected_cash = EXCLUDED.expected_cash,
                          needs_recalculation = FALSE,
                          needs_update = TRUE,
                          last_updated_at = NOW()
                        RETURNING id INTO v_snapshot_id;
                      END IF;

                      -- Retornar el snapshot actualizado
                      RETURN QUERY
                      SELECT
                        scs.id,
                        scs.expected_cash,
                        scs.cash_sales,
                        scs.total_assigned_amount,
                        scs.total_returned_amount,
                        scs.net_amount_to_deliver,
                        scs.cash_difference,
                        scs.needs_update
                      FROM shift_cash_snapshot scs
                      WHERE scs.id = v_snapshot_id;
                    END;
                    $$ LANGUAGE plpgsql;
                `);

                // Function 3: update_shift_cash_delivered
                await client.query(`
                    CREATE OR REPLACE FUNCTION update_shift_cash_delivered(
                      p_shift_id INTEGER,
                      p_actual_cash_delivered DECIMAL
                    )
                    RETURNS TABLE(
                      snapshot_id INTEGER,
                      net_amount_to_deliver DECIMAL,
                      actual_cash_delivered DECIMAL,
                      cash_difference DECIMAL
                    ) AS $$
                    DECLARE
                      v_snapshot_id INTEGER;
                    BEGIN
                      -- Actualizar el dinero entregado y calcular diferencia
                      UPDATE shift_cash_snapshot
                      SET
                        actual_cash_delivered = p_actual_cash_delivered,
                        cash_difference = p_actual_cash_delivered - net_amount_to_deliver,
                        needs_update = TRUE,
                        last_updated_at = NOW()
                      WHERE shift_id = p_shift_id
                      RETURNING id INTO v_snapshot_id;

                      -- Si no existe, lanzar error
                      IF v_snapshot_id IS NULL THEN
                        RAISE EXCEPTION 'No existe snapshot para el turno %', p_shift_id;
                      END IF;

                      -- Retornar datos actualizados
                      RETURN QUERY
                      SELECT
                        scs.id,
                        scs.net_amount_to_deliver,
                        scs.actual_cash_delivered,
                        scs.cash_difference
                      FROM shift_cash_snapshot scs
                      WHERE scs.id = v_snapshot_id;
                    END;
                    $$ LANGUAGE plpgsql;
                `);

                // Function 4: mark_shift_snapshot_for_recalc (for triggers)
                await client.query(`
                    CREATE OR REPLACE FUNCTION mark_shift_snapshot_for_recalc()
                    RETURNS TRIGGER AS $$
                    BEGIN
                      -- Marcar el snapshot como que necesita recalculación
                      UPDATE shift_cash_snapshot
                      SET needs_recalculation = TRUE, last_updated_at = NOW()
                      WHERE shift_id = COALESCE(NEW.repartidor_shift_id, OLD.repartidor_shift_id);

                      RETURN COALESCE(NEW, OLD);
                    END;
                    $$ LANGUAGE plpgsql;
                `);

                // Triggers for assignments and returns
                await client.query(`
                    DROP TRIGGER IF EXISTS trg_assignment_mark_snapshot_recalc ON repartidor_assignments;
                `);
                await client.query(`
                    CREATE TRIGGER trg_assignment_mark_snapshot_recalc
                    AFTER INSERT OR UPDATE OR DELETE ON repartidor_assignments
                    FOR EACH ROW
                    EXECUTE FUNCTION mark_shift_snapshot_for_recalc();
                `);

                await client.query(`
                    DROP TRIGGER IF EXISTS trg_return_mark_snapshot_recalc ON repartidor_returns;
                `);
                await client.query(`
                    CREATE TRIGGER trg_return_mark_snapshot_recalc
                    AFTER INSERT OR UPDATE OR DELETE ON repartidor_returns
                    FOR EACH ROW
                    EXECUTE FUNCTION mark_shift_snapshot_for_recalc();
                `);

                console.log('[Functions] ✅ Cash snapshot functions created successfully');
            } catch (funcError) {
                console.error('[Functions] ❌ Error creating functions:', funcError.message);
                console.error(funcError.stack);
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
