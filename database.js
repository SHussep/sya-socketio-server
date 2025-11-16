// ═══════════════════════════════════════════════════════════════
// DATABASE CONNECTION - PostgreSQL
// ═══════════════════════════════════════════════════════════════

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
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

        // ============================================
        // EJECUTAR SCHEMA COMPLETO DESDE ARCHIVO SQL
        // ============================================
        // En lugar de tener CREATE TABLE individuales aquí,
        // ejecutamos el archivo routes/schema-db.sql que contiene
        // TODAS las tablas, índices, triggers, funciones, etc.

        const schemaPath = path.join(__dirname, 'routes', 'schema-db.sql');

        try {
            console.log('[DB] 📄 Leyendo schema desde:', schemaPath);
            const schemaSql = fs.readFileSync(schemaPath, 'utf8');

            console.log('[DB] 🚀 Ejecutando schema completo...');
            await client.query(schemaSql);

            console.log('[DB] ✅ Schema ejecutado exitosamente');
        } catch (error) {
            console.error('[DB] ❌ Error ejecutando schema:', error.message);
            // Si el archivo no existe o hay error, continuar con migraciones
            // Las migraciones a continuación agregarán las columnas faltantes
        }

        // ============================================
        // FIN DE SCHEMA SQL FILE
        // ============================================

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
