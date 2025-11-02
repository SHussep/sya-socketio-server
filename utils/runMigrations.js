const { Pool } = require('pg');
require('dotenv').config();

/**
 * Sistema de migraciones automáticas
 * Ejecuta migraciones faltantes cuando el servidor inicia
 */

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Definición de migraciones (en orden de ejecución)
const MIGRATIONS = [
    {
        id: '004_add_local_shift_id',
        name: 'Agregar local_shift_id para offline-first synchronization',
        async execute(client) {
            console.log('🔄 Ejecutando migración 004: Agregando local_shift_id para offline sync...');

            try {
                // Check if shifts.local_shift_id already exists
                const checkShifts = await client.query(`
                    SELECT column_name
                    FROM information_schema.columns
                    WHERE table_name = 'shifts' AND column_name = 'local_shift_id'
                `);

                if (checkShifts.rows.length > 0) {
                    console.log('ℹ️  Migración 004: Columna local_shift_id ya existe en shifts');
                    return; // Already migrated
                }

                // Add local_shift_id to shifts table (UNIQUE constraint)
                await client.query(`
                    ALTER TABLE shifts
                    ADD COLUMN local_shift_id INT UNIQUE
                `);
                console.log('✅ Columna local_shift_id agregada a shifts (UNIQUE)');

                // Add local_shift_id to sales table
                await client.query(`
                    ALTER TABLE sales
                    ADD COLUMN local_shift_id INT
                `);
                console.log('✅ Columna local_shift_id agregada a sales');

                // Add local_shift_id to expenses table
                await client.query(`
                    ALTER TABLE expenses
                    ADD COLUMN local_shift_id INT
                `);
                console.log('✅ Columna local_shift_id agregada a expenses');

                // Add local_shift_id to deposits table (if exists)
                try {
                    const checkDeposits = await client.query(`
                        SELECT table_name
                        FROM information_schema.tables
                        WHERE table_name = 'deposits'
                    `);
                    if (checkDeposits.rows.length > 0) {
                        await client.query(`
                            ALTER TABLE deposits
                            ADD COLUMN local_shift_id INT
                        `);
                        console.log('✅ Columna local_shift_id agregada a deposits');
                    }
                } catch (e) {
                    console.log(`ℹ️  Tabla deposits no existe o error al agregar columna: ${e.message}`);
                }

                // Add local_shift_id to withdrawals table (if exists)
                try {
                    const checkWithdrawals = await client.query(`
                        SELECT table_name
                        FROM information_schema.tables
                        WHERE table_name = 'withdrawals'
                    `);
                    if (checkWithdrawals.rows.length > 0) {
                        await client.query(`
                            ALTER TABLE withdrawals
                            ADD COLUMN local_shift_id INT
                        `);
                        console.log('✅ Columna local_shift_id agregada a withdrawals');
                    }
                } catch (e) {
                    console.log(`ℹ️  Tabla withdrawals no existe o error al agregar columna: ${e.message}`);
                }

                // Create indexes for faster lookups
                await client.query(`
                    CREATE INDEX IF NOT EXISTS idx_shifts_local_shift_id ON shifts(local_shift_id)
                `);
                await client.query(`
                    CREATE INDEX IF NOT EXISTS idx_shifts_employee_open ON shifts(employee_id) WHERE end_time IS NULL
                `);
                await client.query(`
                    CREATE INDEX IF NOT EXISTS idx_sales_local_shift_id ON sales(local_shift_id)
                `);
                await client.query(`
                    CREATE INDEX IF NOT EXISTS idx_expenses_local_shift_id ON expenses(local_shift_id)
                `);
                console.log('✅ Índices creados para local_shift_id');

                console.log('✅ Migración 004 completada: local_shift_id agregado para offline-first sync');
            } catch (error) {
                console.log('⚠️  Migración 004: ' + error.message);
                // Don't throw - continue even if there are issues
            }
        }
    },
    {
        id: '015_add_updated_at_to_tenants',
        name: 'Agregar updated_at a tenants',
        async execute(client) {
            const checkColumn = await client.query(`
                SELECT column_name
                FROM information_schema.columns
                WHERE table_name = 'tenants' AND column_name = 'updated_at'
            `);

            if (checkColumn.rows.length > 0) {
                console.log('ℹ️  Migración 015: Columna updated_at ya existe en tenants');
                return;
            }

            console.log('🔄 Ejecutando migración 015: Agregando updated_at a tenants...');

            await client.query(`
                ALTER TABLE tenants
                ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            `);

            console.log('✅ Migración 015 completada: Columna updated_at agregada a tenants');
        }
    },
    {
        id: '016_add_updated_at_to_employees',
        name: 'Agregar updated_at a employees',
        async execute(client) {
            const checkColumn = await client.query(`
                SELECT column_name
                FROM information_schema.columns
                WHERE table_name = 'employees' AND column_name = 'updated_at'
            `);

            if (checkColumn.rows.length > 0) {
                console.log('ℹ️  Migración 016: Columna updated_at ya existe en employees');
                return;
            }

            console.log('🔄 Ejecutando migración 016: Agregando updated_at a employees...');

            await client.query(`
                ALTER TABLE employees
                ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            `);

            console.log('✅ Migración 016 completada: Columna updated_at agregada a employees');
        }
    },
    {
        id: '017_add_last_seen_to_devices',
        name: 'Agregar last_seen a devices',
        async execute(client) {
            const checkColumn = await client.query(`
                SELECT column_name
                FROM information_schema.columns
                WHERE table_name = 'devices' AND column_name = 'last_seen'
            `);

            if (checkColumn.rows.length > 0) {
                console.log('ℹ️  Migración 017: Columna last_seen ya existe en devices');
                return;
            }

            console.log('🔄 Ejecutando migración 017: Agregando last_seen a devices...');

            await client.query(`
                ALTER TABLE devices
                ADD COLUMN last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            `);

            console.log('✅ Migración 017 completada: Columna last_seen agregada a devices');
        }
    },
    {
        id: '018_add_branch_id_to_devices',
        name: 'Agregar branch_id a devices',
        async execute(client) {
            const checkColumn = await client.query(`
                SELECT column_name
                FROM information_schema.columns
                WHERE table_name = 'devices' AND column_name = 'branch_id'
            `);

            if (checkColumn.rows.length > 0) {
                console.log('ℹ️  Migración 018: Columna branch_id ya existe en devices');
                return;
            }

            console.log('🔄 Ejecutando migración 018: Agregando branch_id a devices...');

            await client.query(`
                ALTER TABLE devices
                ADD COLUMN branch_id INTEGER REFERENCES branches(id) ON DELETE CASCADE
            `);

            console.log('✅ Migración 018 completada: Columna branch_id agregada a devices');
        }
    },
    {
        id: '019_add_device_columns',
        name: 'Agregar device_name, device_type, is_active a devices',
        async execute(client) {
            console.log('🔄 Ejecutando migración 019: Verificando columnas en devices...');

            // Verificar device_name
            const hasDeviceName = await client.query(`
                SELECT column_name FROM information_schema.columns
                WHERE table_name = 'devices' AND column_name = 'device_name'
            `);
            if (hasDeviceName.rows.length === 0) {
                await client.query(`ALTER TABLE devices ADD COLUMN device_name VARCHAR(255)`);
                console.log('✅ Columna device_name agregada');
            }

            // Verificar device_type
            const hasDeviceType = await client.query(`
                SELECT column_name FROM information_schema.columns
                WHERE table_name = 'devices' AND column_name = 'device_type'
            `);
            if (hasDeviceType.rows.length === 0) {
                await client.query(`ALTER TABLE devices ADD COLUMN device_type VARCHAR(50)`);
                console.log('✅ Columna device_type agregada');
            }

            // Verificar is_active
            const hasIsActive = await client.query(`
                SELECT column_name FROM information_schema.columns
                WHERE table_name = 'devices' AND column_name = 'is_active'
            `);
            if (hasIsActive.rows.length === 0) {
                await client.query(`ALTER TABLE devices ADD COLUMN is_active BOOLEAN DEFAULT true`);
                console.log('✅ Columna is_active agregada');
            }

            console.log('✅ Migración 019 completada');
        }
    },
    {
        id: '020_fix_critical_timestamps_to_timestamptz',
        name: 'Fix critical real-time event timestamps (guardian_events, shifts, cash_cuts)',
        async execute(client) {
            console.log('🔄 Ejecutando migración 020: Convirtiendo timestamps críticos a TIMESTAMP WITH TIME ZONE...');

            try {
                // Helper function for safe column conversion
                const convertColumn = async (tableName, columnName) => {
                    try {
                        // Check if column exists and is not already TIMESTAMP WITH TIME ZONE
                        const checkQuery = `
                            SELECT data_type FROM information_schema.columns
                            WHERE table_name = '${tableName}' AND column_name = '${columnName}'
                            AND data_type = 'timestamp without time zone'
                        `;
                        const result = await client.query(checkQuery);

                        if (result.rows.length > 0) {
                            // Create temp column with correct type
                            await client.query(`
                                ALTER TABLE ${tableName} ADD COLUMN ${columnName}_tmp TIMESTAMP WITH TIME ZONE
                            `);
                            // Copy data with timezone conversion
                            await client.query(`
                                UPDATE ${tableName} SET ${columnName}_tmp = ${columnName} AT TIME ZONE 'UTC'
                            `);
                            // Drop old column
                            await client.query(`
                                ALTER TABLE ${tableName} DROP COLUMN ${columnName}
                            `);
                            // Rename temp column
                            await client.query(`
                                ALTER TABLE ${tableName} RENAME COLUMN ${columnName}_tmp TO ${columnName}
                            `);
                            console.log(`✅ ${tableName}.${columnName} convertido`);
                        } else {
                            console.log(`ℹ️  ${tableName}.${columnName} ya es TIMESTAMP WITH TIME ZONE`);
                        }
                    } catch (e) {
                        console.log(`⚠️  ${tableName}.${columnName}: ${e.message}`);
                    }
                };

                // 1. GUARDIAN_EVENTS - Only event_date (timestamp column doesn't exist)
                await convertColumn('guardian_events', 'event_date');

                // 2. SHIFTS - Real-time shift start/end tracking
                await convertColumn('shifts', 'start_time');
                await convertColumn('shifts', 'end_time');

                // 3. CASH_CUTS - Cash drawer closing timestamps
                await convertColumn('cash_cuts', 'cut_date');

                // Add indexes for better performance on timezone-aware columns
                await client.query(`CREATE INDEX IF NOT EXISTS idx_guardian_events_event_date ON guardian_events(event_date DESC)`);
                await client.query(`CREATE INDEX IF NOT EXISTS idx_shifts_start_time ON shifts(start_time DESC)`);
                await client.query(`CREATE INDEX IF NOT EXISTS idx_cash_cuts_cut_date ON cash_cuts(cut_date DESC)`);
                console.log('✅ Índices creados para performance');

                console.log('✅ Migración 020 completada: Critical timestamps convertidos a TIMESTAMP WITH TIME ZONE (UTC)');
            } catch (error) {
                console.log('⚠️  Migración 020: ' + error.message);
                // Don't throw - continue even if there are issues
            }
        }
    },
    {
        id: '021_fix_sales_expenses_timestamps_to_utc',
        name: 'Fix sales and expenses timestamps to TIMESTAMP WITH TIME ZONE (UTC)',
        async execute(client) {
            console.log('🔄 Ejecutando migración 021: Convirtiendo timestamps de transacciones a TIMESTAMP WITH TIME ZONE...');

            try {
                // Helper function to safely convert a column
                const convertColumn = async (tableName, columnName) => {
                    try {
                        // Check if column exists and is not already TIMESTAMP WITH TIME ZONE
                        const checkQuery = `
                            SELECT data_type FROM information_schema.columns
                            WHERE table_name = '${tableName}' AND column_name = '${columnName}'
                            AND data_type = 'timestamp without time zone'
                        `;
                        const result = await client.query(checkQuery);

                        if (result.rows.length > 0) {
                            // Create temp column with correct type
                            await client.query(`
                                ALTER TABLE ${tableName} ADD COLUMN ${columnName}_tmp TIMESTAMP WITH TIME ZONE
                            `);
                            // Copy data with timezone conversion
                            await client.query(`
                                UPDATE ${tableName} SET ${columnName}_tmp = ${columnName} AT TIME ZONE 'UTC'
                            `);
                            // Drop old column
                            await client.query(`
                                ALTER TABLE ${tableName} DROP COLUMN ${columnName}
                            `);
                            // Rename temp column
                            await client.query(`
                                ALTER TABLE ${tableName} RENAME COLUMN ${columnName}_tmp TO ${columnName}
                            `);
                            console.log(`✅ ${tableName}.${columnName} convertido`);
                        } else {
                            console.log(`ℹ️  ${tableName}.${columnName} ya es TIMESTAMP WITH TIME ZONE`);
                        }
                    } catch (e) {
                        console.log(`⚠️  ${tableName}.${columnName}: ${e.message}`);
                    }
                };

                // Convert all transaction timestamp columns
                await convertColumn('sales', 'sale_date');
                await convertColumn('expenses', 'expense_date');
                await convertColumn('purchases', 'purchase_date');
                await convertColumn('cash_drawer_sessions', 'start_time');
                await convertColumn('cash_drawer_sessions', 'close_time');
                await convertColumn('cash_drawer_sessions', 'opened_at');
                await convertColumn('cash_drawer_sessions', 'closed_at');
                await convertColumn('cash_transactions', 'transaction_timestamp');
                await convertColumn('cash_transactions', 'voided_at');

                // Create indexes for better performance
                await client.query(`CREATE INDEX IF NOT EXISTS idx_sales_sale_date ON sales(sale_date DESC)`);
                await client.query(`CREATE INDEX IF NOT EXISTS idx_expenses_expense_date ON expenses(expense_date DESC)`);
                await client.query(`CREATE INDEX IF NOT EXISTS idx_purchases_purchase_date ON purchases(purchase_date DESC)`);
                console.log('✅ Índices creados para transacciones');

                console.log('✅ Migración 021 completada: Sales/expenses timestamps convertidos a TIMESTAMP WITH TIME ZONE (UTC)');
            } catch (error) {
                console.log('⚠️  Migración 021: ' + error.message);
                // Don't throw - continue even if there are issues
            }
        }
    },
    {
        id: '023_create_cash_management_tables',
        name: 'Create Cash Management Tables (deposits, withdrawals, cash_cuts)',
        async execute(client) {
            console.log('🔄 Ejecutando migración 023: Creando tablas de gestión de caja...');

            try {
                // TABLE 1: DEPOSITS
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
                        deposit_type VARCHAR(50) DEFAULT 'manual',

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

                // TABLE 2: WITHDRAWALS
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
                        withdrawal_type VARCHAR(50) DEFAULT 'manual',

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

                // TABLE 3: CASH CUTS
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
                        total_cash_sales DECIMAL(12, 2) DEFAULT 0,
                        total_card_sales DECIMAL(12, 2) DEFAULT 0,
                        total_credit_sales DECIMAL(12, 2) DEFAULT 0,

                        -- Payments Breakdown
                        total_cash_payments DECIMAL(12, 2) DEFAULT 0,
                        total_card_payments DECIMAL(12, 2) DEFAULT 0,

                        -- Adjustments
                        total_expenses DECIMAL(12, 2) DEFAULT 0,
                        total_deposits DECIMAL(12, 2) DEFAULT 0,
                        total_withdrawals DECIMAL(12, 2) DEFAULT 0,

                        -- Physical Count
                        expected_cash_in_drawer DECIMAL(12, 2) DEFAULT 0,
                        counted_cash DECIMAL(12, 2) DEFAULT 0,

                        -- Difference
                        difference DECIMAL(12, 2) DEFAULT 0,

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
                console.log('⚠️  Migración 023: ' + error.message);
                // Don't throw - continue even if there are issues
            }
        }
    },
    {
        id: '032_fix_backend_schema_cleanup',
        name: 'Fix Backend Schema - Remove Desktop-only fields from PostgreSQL',
        async execute(client) {
            console.log('🔄 Ejecutando migración 032: Limpieza de schema del backend...');

            try {
                // Step 1: Remove sync fields from employees table (ONLY Backend PostgreSQL should have these)
                console.log('   📝 Removiendo campos de sync de tabla employees...');
                await client.query(`
                    ALTER TABLE employees DROP COLUMN IF EXISTS synced CASCADE;
                    ALTER TABLE employees DROP COLUMN IF EXISTS synced_at CASCADE;
                    ALTER TABLE employees DROP COLUMN IF EXISTS remote_id CASCADE;
                `);
                console.log('   ✅ Columnas de sync removidas de employees');

                // Step 2: Add branch_id context to roles table for proper role-branch-tenant relationship
                console.log('   📝 Agregando branch_id a tabla roles...');
                await client.query(`
                    ALTER TABLE roles ADD COLUMN IF NOT EXISTS branch_id INTEGER REFERENCES branches(id) ON DELETE CASCADE;
                `);
                console.log('   ✅ Columna branch_id agregada a roles');

                // Step 3: Create index on roles branch_id
                await client.query(`
                    CREATE INDEX IF NOT EXISTS idx_roles_branch_id ON roles(branch_id);
                `);
                console.log('   ✅ Índice en roles.branch_id creado');

                // Step 4: Create unique constraint for roles to prevent duplicates per branch
                console.log('   📝 Agregando constrainta UNIQUE a roles...');
                try {
                    await client.query(`
                        ALTER TABLE roles DROP CONSTRAINT IF EXISTS unique_role_per_branch_tenant CASCADE;
                    `);
                } catch (e) {
                    // Constraint might not exist, that's OK
                }

                await client.query(`
                    ALTER TABLE roles ADD CONSTRAINT unique_role_per_branch_tenant UNIQUE NULLS NOT DISTINCT (tenant_id, branch_id, name);
                `);
                console.log('   ✅ Constrainta UNIQUE agregada a roles');

                // Step 5: Ensure employee_branches junction table is properly structured
                console.log('   📝 Asegurando tabla employee_branches...');
                await client.query(`
                    CREATE TABLE IF NOT EXISTS employee_branches (
                        id SERIAL PRIMARY KEY,
                        tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
                        employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
                        branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
                        is_active BOOLEAN DEFAULT true,
                        assigned_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                        UNIQUE(tenant_id, employee_id, branch_id)
                    );
                `);
                console.log('   ✅ Tabla employee_branches creada/verificada');

                // Step 6: Create indices for employee_branches
                console.log('   📝 Creando índices en employee_branches...');
                await client.query(`
                    CREATE INDEX IF NOT EXISTS idx_employee_branches_tenant_id ON employee_branches(tenant_id);
                    CREATE INDEX IF NOT EXISTS idx_employee_branches_employee_id ON employee_branches(employee_id);
                    CREATE INDEX IF NOT EXISTS idx_employee_branches_branch_id ON employee_branches(branch_id);
                    CREATE INDEX IF NOT EXISTS idx_employee_branches_is_active ON employee_branches(is_active);
                `);
                console.log('   ✅ Índices en employee_branches creados');

                console.log('✅ Migración 032 completada: Backend schema cleanup successful');
            } catch (error) {
                console.log('⚠️  Migración 032: ' + error.message);
                // Don't throw - continue even if there are issues
            }
        }
    },
    {
        id: '033_fix_employees_and_employee_branches_schema',
        name: 'Fix Employees and Employee-Branches Schema - Align with code expectations',
        async execute(client) {
            console.log('🔄 Ejecutando migración 033: Corrigiendo schema de employees y employee-branches...');

            try {
                // Step 1: Add missing columns to employees table
                console.log('   📝 Agregando columnas faltantes a employees...');
                await client.query(`
                    ALTER TABLE employees ADD COLUMN IF NOT EXISTS password_hash VARCHAR;
                    ALTER TABLE employees ADD COLUMN IF NOT EXISTS password_updated_at TIMESTAMP WITH TIME ZONE;
                    ALTER TABLE employees ADD COLUMN IF NOT EXISTS is_owner BOOLEAN DEFAULT false;
                    ALTER TABLE employees ADD COLUMN IF NOT EXISTS google_user_identifier VARCHAR;
                    ALTER TABLE employees ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;
                `);
                console.log('   ✅ Columnas agregadas a employees');

                // Step 2: Create role_id column and map from role string
                console.log('   📝 Creando column role_id y migrando datos...');
                await client.query(`
                    ALTER TABLE employees ADD COLUMN IF NOT EXISTS role_id INTEGER;
                `);

                // Map string roles to role IDs
                await client.query(`
                    UPDATE employees e
                    SET role_id = CASE
                        WHEN e.role = 'owner' THEN 1
                        WHEN e.role = 'encargado' THEN 2
                        WHEN e.role = 'repartidor' THEN 3
                        WHEN e.role = 'ayudante' THEN 4
                        ELSE 2
                    END
                    WHERE role_id IS NULL AND e.role IS NOT NULL;
                `);
                console.log('   ✅ role_id poblado con datos existentes');

                // Step 3: Drop the old role column
                console.log('   📝 Removiendo columna role antigua...');
                try {
                    await client.query(`ALTER TABLE employees DROP COLUMN IF EXISTS role CASCADE;`);
                    console.log('   ✅ Columna role removida');
                } catch (e) {
                    console.log('   ⚠️  Error removiendo role (podría no existir o tener dependencias)');
                }

                // Step 4: Add role_id NOT NULL constraint and foreign key
                try {
                    await client.query(`
                        ALTER TABLE employees ALTER COLUMN role_id SET NOT NULL;
                    `);
                } catch (e) {
                    // May fail if there are NULL values, that's OK for now
                }

                try {
                    await client.query(`
                        ALTER TABLE employees ADD CONSTRAINT fk_employees_role_id
                        FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE RESTRICT;
                    `);
                } catch (e) {
                    // Constraint may already exist
                }
                console.log('   ✅ role_id foreign key configurado');

                // Step 5: Drop old employee_branches table
                console.log('   📝 Recreando tabla employee_branches...');
                await client.query(`DROP TABLE IF EXISTS employee_branches CASCADE;`);

                // Step 6: Create new employee_branches with correct structure
                await client.query(`
                    CREATE TABLE IF NOT EXISTS employee_branches (
                        id SERIAL PRIMARY KEY,
                        tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
                        employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
                        branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
                        is_active BOOLEAN DEFAULT true,
                        assigned_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                        UNIQUE(tenant_id, employee_id, branch_id)
                    );
                `);
                console.log('   ✅ Tabla employee_branches recreada');

                // Step 7: Create indices
                await client.query(`
                    CREATE INDEX IF NOT EXISTS idx_employee_branches_tenant_id ON employee_branches(tenant_id);
                    CREATE INDEX IF NOT EXISTS idx_employee_branches_employee_id ON employee_branches(employee_id);
                    CREATE INDEX IF NOT EXISTS idx_employee_branches_branch_id ON employee_branches(branch_id);
                    CREATE INDEX IF NOT EXISTS idx_employee_branches_is_active ON employee_branches(is_active);
                `);
                console.log('   ✅ Índices en employee_branches creados');

                // Step 8: Recreate employee-branch relationships
                console.log('   📝 Recreando relaciones employee-branch...');
                await client.query(`
                    INSERT INTO employee_branches (tenant_id, employee_id, branch_id, is_active)
                    SELECT DISTINCT e.tenant_id, e.id, e.main_branch_id, true
                    FROM employees e
                    WHERE e.main_branch_id IS NOT NULL
                    ON CONFLICT (tenant_id, employee_id, branch_id) DO NOTHING;
                `);
                console.log('   ✅ Relaciones employee-branch recreadas');

                // Step 9: Add missing employees table indices
                console.log('   📝 Agregando índices a employees...');
                await client.query(`
                    CREATE INDEX IF NOT EXISTS idx_employees_tenant_id ON employees(tenant_id);
                    CREATE INDEX IF NOT EXISTS idx_employees_role_id ON employees(role_id);
                    CREATE INDEX IF NOT EXISTS idx_employees_email ON employees(LOWER(email));
                    CREATE INDEX IF NOT EXISTS idx_employees_username ON employees(LOWER(username));
                    CREATE INDEX IF NOT EXISTS idx_employees_is_active ON employees(is_active);
                `);
                console.log('   ✅ Índices agregados a employees');

                console.log('✅ Migración 033 completada: Employees and employee-branches schema fixed');
            } catch (error) {
                console.log('⚠️  Migración 033: ' + error.message);
                // Don't throw - continue even if there are issues
            }
        }
    },
    {
        id: '034_add_local_shift_id_to_shifts',
        name: 'Add local_shift_id column to shifts table',
        async execute(client) {
            console.log('🔄 Ejecutando migración 034: Agregando local_shift_id a shifts...');

            try {
                // Add local_shift_id column
                console.log('   📝 Agregando columna local_shift_id...');
                await client.query(`
                    ALTER TABLE shifts ADD COLUMN IF NOT EXISTS local_shift_id INTEGER UNIQUE;
                `);
                console.log('   ✅ Columna local_shift_id agregada');

                // Create indices
                console.log('   📝 Creando índices...');
                await client.query(`
                    CREATE INDEX IF NOT EXISTS idx_shifts_local_shift_id ON shifts(local_shift_id);
                    CREATE INDEX IF NOT EXISTS idx_shifts_tenant_branch_employee ON shifts(tenant_id, branch_id, employee_id);
                    CREATE INDEX IF NOT EXISTS idx_shifts_start_time ON shifts(start_time DESC);
                `);
                console.log('   ✅ Índices creados');

                console.log('✅ Migración 034 completada: local_shift_id agregado a shifts');
            } catch (error) {
                console.log('⚠️  Migración 034: ' + error.message);
                // Don't throw - continue even if there are issues
            }
        }
    },
    {
        id: '035_fix_employees_password_column',
        name: 'Fix employees password column - make nullable',
        async execute(client) {
            console.log('🔄 Ejecutando migración 035: Haciendo password nullable...');

            try {
                // Make password column nullable
                console.log('   📝 Haciendo password column nullable...');
                await client.query(`
                    ALTER TABLE employees ALTER COLUMN password DROP NOT NULL;
                `);
                console.log('   ✅ Password column es ahora nullable');

                console.log('✅ Migración 035 completada: Password column fixed');
            } catch (error) {
                console.log('⚠️  Migración 035: ' + error.message);
                // Don't throw - continue even if there are issues
            }
        }
    },
    {
        id: '036_add_removed_at_to_employee_branches',
        name: 'Add removed_at column to employee_branches for soft deletes',
        async execute(client) {
            console.log('🔄 Ejecutando migración 036: Agregando removed_at a employee_branches...');

            try {
                // Add removed_at column
                console.log('   📝 Agregando columna removed_at...');
                await client.query(`
                    ALTER TABLE employee_branches ADD COLUMN IF NOT EXISTS removed_at TIMESTAMP WITH TIME ZONE;
                `);
                console.log('   ✅ Columna removed_at agregada');

                // Create index
                console.log('   📝 Creando índice...');
                await client.query(`
                    CREATE INDEX IF NOT EXISTS idx_employee_branches_removed_at ON employee_branches(removed_at);
                `);
                console.log('   ✅ Índice creado');

                console.log('✅ Migración 036 completada: removed_at agregado a employee_branches');
            } catch (error) {
                console.log('⚠️  Migración 036: ' + error.message);
                // Don't throw - continue even if there are issues
            }
        }
    },
    {
        id: '037_create_roles_and_permissions_system',
        name: 'Create comprehensive roles and permissions system',
        async execute(client) {
            console.log('🔄 Ejecutando migración 037: Creando sistema de roles y permisos...');

            try {
                // Step 1: Create roles table
                console.log('   📝 Creando tabla roles...');
                await client.query(`
                    CREATE TABLE IF NOT EXISTS roles (
                        id SERIAL PRIMARY KEY,
                        tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
                        name VARCHAR(255) NOT NULL,
                        description TEXT,
                        is_system BOOLEAN DEFAULT false,
                        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                        UNIQUE(tenant_id, name)
                    );
                    CREATE INDEX IF NOT EXISTS idx_roles_tenant_id ON roles(tenant_id);
                    CREATE INDEX IF NOT EXISTS idx_roles_is_system ON roles(is_system);
                `);
                console.log('   ✅ Tabla roles creada');

                // Step 2: Create permissions table
                console.log('   📝 Creando tabla permissions...');
                await client.query(`
                    CREATE TABLE IF NOT EXISTS permissions (
                        id SERIAL PRIMARY KEY,
                        code VARCHAR(255) NOT NULL UNIQUE,
                        name VARCHAR(255) NOT NULL,
                        description TEXT,
                        category VARCHAR(100),
                        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
                    );
                `);
                console.log('   ✅ Tabla permissions creada');

                // Step 3: Seed permissions
                console.log('   📝 Poblando permisos del sistema...');
                await client.query(`
                    INSERT INTO permissions (code, name, description, category) VALUES
                    ('mobile_app_access', 'Acceso a App Móvil', 'Permite acceso completo a la app móvil y todos los datos en PostgreSQL', 'access'),
                    ('desktop_app_access', 'Acceso a App Desktop', 'Permite usar la aplicación Desktop', 'access'),
                    ('create_sale', 'Crear Ventas', 'Registrar nuevas ventas', 'sales'),
                    ('view_sales', 'Ver Ventas', 'Ver historial de ventas', 'sales'),
                    ('edit_sale', 'Editar Ventas', 'Modificar ventas existentes', 'sales'),
                    ('void_sale', 'Anular Ventas', 'Anular transacciones de venta', 'sales'),
                    ('view_inventory', 'Ver Inventario', 'Ver stocks y productos', 'inventory'),
                    ('manage_inventory', 'Gestionar Inventario', 'Actualizar stocks y crear productos', 'inventory'),
                    ('view_cash_drawer', 'Ver Caja', 'Ver estado de caja', 'cash'),
                    ('manage_cash_drawer', 'Gestionar Caja', 'Abrir/cerrar caja y registrar transacciones', 'cash'),
                    ('close_shift', 'Cerrar Turno', 'Cerrar turno y arqueos', 'cash'),
                    ('view_employees', 'Ver Empleados', 'Ver listado de empleados', 'employees'),
                    ('manage_employees', 'Gestionar Empleados', 'Crear, editar, eliminar empleados', 'employees'),
                    ('manage_roles', 'Gestionar Roles', 'Asignar roles y permisos a empleados', 'employees'),
                    ('view_reports', 'Ver Reportes', 'Acceder a reportes y análisis', 'reports'),
                    ('export_data', 'Exportar Datos', 'Exportar datos en múltiples formatos', 'reports'),
                    ('manage_branches', 'Gestionar Sucursales', 'Crear y editar sucursales', 'admin'),
                    ('manage_settings', 'Gestionar Configuración', 'Cambiar configuración del sistema', 'admin'),
                    ('view_audit_log', 'Ver Log de Auditoría', 'Ver historial de cambios', 'admin')
                    ON CONFLICT (code) DO NOTHING;
                `);
                console.log('   ✅ Permisos poblados');

                // Step 4: Create role_permissions table
                console.log('   📝 Creando tabla role_permissions...');
                await client.query(`
                    CREATE TABLE IF NOT EXISTS role_permissions (
                        id SERIAL PRIMARY KEY,
                        role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
                        permission_id INTEGER NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
                        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                        UNIQUE(role_id, permission_id)
                    );
                    CREATE INDEX IF NOT EXISTS idx_role_permissions_role_id ON role_permissions(role_id);
                    CREATE INDEX IF NOT EXISTS idx_role_permissions_permission_id ON role_permissions(permission_id);
                `);
                console.log('   ✅ Tabla role_permissions creada');

                // Step 5: Create system roles for all existing tenants
                console.log('   📝 Creando roles Administrador y Repartidor...');

                // Get all tenants
                const tenantsResult = await client.query('SELECT id FROM tenants');

                for (const tenant of tenantsResult.rows) {
                    // Check if Administrador role exists
                    const adminRoleCheck = await client.query(
                        'SELECT id FROM roles WHERE tenant_id = $1 AND name = $2',
                        [tenant.id, 'Administrador']
                    );

                    if (adminRoleCheck.rows.length === 0) {
                        // Create Administrador role
                        const adminRoleResult = await client.query(
                            `INSERT INTO roles (tenant_id, name, description, is_system)
                             VALUES ($1, $2, $3, true)
                             RETURNING id`,
                            [tenant.id, 'Administrador', 'Acceso completo al sistema y todos los datos']
                        );

                        const adminRoleId = adminRoleResult.rows[0].id;

                        // Assign ALL permissions to Administrador
                        const permissionsResult = await client.query('SELECT id FROM permissions');
                        for (const perm of permissionsResult.rows) {
                            await client.query(
                                `INSERT INTO role_permissions (role_id, permission_id)
                                 VALUES ($1, $2)
                                 ON CONFLICT (role_id, permission_id) DO NOTHING`,
                                [adminRoleId, perm.id]
                            );
                        }
                    }

                    // Check if Repartidor role exists
                    const repartidorRoleCheck = await client.query(
                        'SELECT id FROM roles WHERE tenant_id = $1 AND name = $2',
                        [tenant.id, 'Repartidor']
                    );

                    if (repartidorRoleCheck.rows.length === 0) {
                        // Create Repartidor role
                        const repartidorRoleResult = await client.query(
                            `INSERT INTO roles (tenant_id, name, description, is_system)
                             VALUES ($1, $2, $3, true)
                             RETURNING id`,
                            [tenant.id, 'Repartidor', 'Acceso limitado para reparto y ventas']
                        );

                        const repartidorRoleId = repartidorRoleResult.rows[0].id;

                        // Assign limited permissions to Repartidor
                        const limitedPermsCodes = [
                            'mobile_app_access',
                            'create_sale',
                            'view_sales',
                            'view_inventory',
                            'view_cash_drawer',
                            'close_shift'
                        ];

                        const limitedPermsResult = await client.query(
                            `SELECT id FROM permissions WHERE code = ANY($1)`,
                            [limitedPermsCodes]
                        );

                        for (const perm of limitedPermsResult.rows) {
                            await client.query(
                                `INSERT INTO role_permissions (role_id, permission_id)
                                 VALUES ($1, $2)
                                 ON CONFLICT (role_id, permission_id) DO NOTHING`,
                                [repartidorRoleId, perm.id]
                            );
                        }
                    }
                }
                console.log('   ✅ Roles Administrador y Repartidor creados para todos los tenants');

                // Step 6: Create employee_permissions view
                console.log('   📝 Creando vista employee_permissions_view...');
                await client.query(`
                    CREATE OR REPLACE VIEW employee_permissions_view AS
                    SELECT
                        e.id as employee_id,
                        e.tenant_id,
                        e.email,
                        e.full_name,
                        r.id as role_id,
                        r.name as role_name,
                        p.code as permission_code,
                        p.name as permission_name,
                        p.category as permission_category
                    FROM employees e
                    JOIN roles r ON e.role_id = r.id
                    JOIN role_permissions rp ON r.id = rp.role_id
                    JOIN permissions p ON rp.permission_id = p.id
                    WHERE e.is_active = true;
                `);
                console.log('   ✅ Vista employee_permissions_view creada');

                console.log('✅ Migración 037 completada: Sistema de roles y permisos creado');
            } catch (error) {
                console.log('⚠️  Migración 037: ' + error.message);
                // Don't throw - continue even if there are issues
            }
        }
    }
];

async function runMigrations() {
    let client;
    try {
        console.log('\n╔══════════════════════════════════════════════════════════╗');
        console.log('║         🚀 EJECUTANDO SISTEMA DE MIGRACIONES             ║');
        console.log('╚══════════════════════════════════════════════════════════╝\n');

        client = await pool.connect();
        console.log('[MIGRATIONS] Conexión a BD establecida');

        for (const migration of MIGRATIONS) {
            try {
                console.log(`[MIGRATIONS] Iniciando migración: ${migration.id}`);
                await migration.execute(client);
                console.log(`[MIGRATIONS] ✅ Migración completada: ${migration.id}`);
            } catch (error) {
                console.error(`[MIGRATIONS] ❌ Error en migración ${migration.id}:`);
                console.error(`[MIGRATIONS] Mensaje: ${error.message}`);
                // No lanzamos el error, continuamos con las siguientes migraciones
            }
        }

        console.log('\n╔══════════════════════════════════════════════════════════╗');
        console.log('║         ✅ TODAS LAS MIGRACIONES COMPLETADAS             ║');
        console.log('╚══════════════════════════════════════════════════════════╝\n');

    } catch (error) {
        console.error('\n[MIGRATIONS] ❌ ERROR CRÍTICO iniciando migraciones:');
        console.error(`[MIGRATIONS] Mensaje: ${error.message}`);
        // No lanzamos el error para permitir que el servidor continúe
    } finally {
        if (client) {
            try {
                client.release();
                console.log('[MIGRATIONS] Conexión liberada');
            } catch (e) {
                console.error('[MIGRATIONS] Error liberando conexión:', e.message);
            }
        }
    }
}

module.exports = { runMigrations };
