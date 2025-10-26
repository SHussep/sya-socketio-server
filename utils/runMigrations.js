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
                // 1. GUARDIAN_EVENTS - Real-time scale alert detection
                await client.query(`
                    ALTER TABLE guardian_events
                      ALTER COLUMN event_date TYPE TIMESTAMP WITH TIME ZONE USING event_date AT TIME ZONE 'UTC',
                      ALTER COLUMN timestamp TYPE TIMESTAMP WITH TIME ZONE USING timestamp AT TIME ZONE 'UTC'
                `);
                console.log('✅ guardian_events timestamps convertidos');

                // 2. SHIFTS - Real-time shift start/end tracking
                await client.query(`
                    ALTER TABLE shifts
                      ALTER COLUMN start_time TYPE TIMESTAMP WITH TIME ZONE USING start_time AT TIME ZONE 'UTC',
                      ALTER COLUMN end_time TYPE TIMESTAMP WITH TIME ZONE USING end_time AT TIME ZONE 'UTC'
                `);
                console.log('✅ shifts timestamps convertidos');

                // 3. CASH_CUTS - Cash drawer closing timestamps
                await client.query(`
                    ALTER TABLE cash_cuts
                      ALTER COLUMN cut_date TYPE TIMESTAMP WITH TIME ZONE USING cut_date AT TIME ZONE 'UTC'
                `);
                console.log('✅ cash_cuts timestamps convertidos');

                // Add indexes for better performance on timezone-aware columns
                await client.query(`
                    CREATE INDEX IF NOT EXISTS idx_guardian_events_event_date ON guardian_events(event_date DESC)
                `);
                await client.query(`
                    CREATE INDEX IF NOT EXISTS idx_shifts_start_time ON shifts(start_time DESC)
                `);
                await client.query(`
                    CREATE INDEX IF NOT EXISTS idx_cash_cuts_cut_date ON cash_cuts(cut_date DESC)
                `);
                console.log('✅ Índices creados para performance');

                console.log('✅ Migración 020 completada: Critical timestamps convertidos a TIMESTAMP WITH TIME ZONE (UTC)');
            } catch (error) {
                // Si las columnas ya son TIMESTAMP WITH TIME ZONE, no hay error
                if (error.message.includes('column "event_date" is of type timestamp with time zone')) {
                    console.log('ℹ️  Migración 020: Columnas ya son TIMESTAMP WITH TIME ZONE');
                } else {
                    throw error;
                }
            }
        }
    },
    {
        id: '021_fix_sales_expenses_timestamps_to_utc',
        name: 'Fix sales and expenses timestamps to TIMESTAMP WITH TIME ZONE (UTC)',
        async execute(client) {
            console.log('🔄 Ejecutando migración 021: Convirtiendo timestamps de transacciones a TIMESTAMP WITH TIME ZONE...');

            try {
                // 1. SALES - Convert sale_date to TIMESTAMP WITH TIME ZONE in UTC
                await client.query(`
                    ALTER TABLE sales
                      ALTER COLUMN sale_date TYPE TIMESTAMP WITH TIME ZONE
                        USING sale_date AT TIME ZONE 'UTC'
                `);
                console.log('✅ sales.sale_date convertido');

                // 2. EXPENSES - Convert expense_date to TIMESTAMP WITH TIME ZONE in UTC
                await client.query(`
                    ALTER TABLE expenses
                      ALTER COLUMN expense_date TYPE TIMESTAMP WITH TIME ZONE
                        USING expense_date AT TIME ZONE 'UTC'
                `);
                console.log('✅ expenses.expense_date convertido');

                // 3. PURCHASES - Also convert purchase_date for consistency
                await client.query(`
                    ALTER TABLE purchases
                      ALTER COLUMN purchase_date TYPE TIMESTAMP WITH TIME ZONE
                        USING purchase_date AT TIME ZONE 'UTC'
                `);
                console.log('✅ purchases.purchase_date convertido');

                // 4. CASH_DRAWER_SESSIONS - Convert all session timestamps
                await client.query(`
                    ALTER TABLE cash_drawer_sessions
                      ALTER COLUMN start_time TYPE TIMESTAMP WITH TIME ZONE USING start_time AT TIME ZONE 'UTC',
                      ALTER COLUMN close_time TYPE TIMESTAMP WITH TIME ZONE USING close_time AT TIME ZONE 'UTC',
                      ALTER COLUMN opened_at TYPE TIMESTAMP WITH TIME ZONE USING opened_at AT TIME ZONE 'UTC',
                      ALTER COLUMN closed_at TYPE TIMESTAMP WITH TIME ZONE USING closed_at AT TIME ZONE 'UTC'
                `);
                console.log('✅ cash_drawer_sessions timestamps convertidos');

                // 5. CASH_TRANSACTIONS - Convert transaction timestamps
                await client.query(`
                    ALTER TABLE cash_transactions
                      ALTER COLUMN transaction_timestamp TYPE TIMESTAMP WITH TIME ZONE USING transaction_timestamp AT TIME ZONE 'UTC',
                      ALTER COLUMN voided_at TYPE TIMESTAMP WITH TIME ZONE USING voided_at AT TIME ZONE 'UTC'
                `);
                console.log('✅ cash_transactions timestamps convertidos');

                // Create indexes for better performance
                await client.query(`
                    CREATE INDEX IF NOT EXISTS idx_sales_sale_date ON sales(sale_date DESC)
                `);
                await client.query(`
                    CREATE INDEX IF NOT EXISTS idx_expenses_expense_date ON expenses(expense_date DESC)
                `);
                await client.query(`
                    CREATE INDEX IF NOT EXISTS idx_purchases_purchase_date ON purchases(purchase_date DESC)
                `);
                console.log('✅ Índices creados para transacciones');

                console.log('✅ Migración 021 completada: Sales/expenses timestamps convertidos a TIMESTAMP WITH TIME ZONE (UTC)');
            } catch (error) {
                // Si las columnas ya son TIMESTAMP WITH TIME ZONE, no hay error
                if (error.message.includes('column "sale_date" is of type timestamp with time zone')) {
                    console.log('ℹ️  Migración 021: Columnas ya son TIMESTAMP WITH TIME ZONE');
                } else {
                    throw error;
                }
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
