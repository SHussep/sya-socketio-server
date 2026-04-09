// ═══════════════════════════════════════════════════════════════
// DATABASE MIGRATIONS - Column additions and schema changes
// ═══════════════════════════════════════════════════════════════

const { rawPool: pool } = require('./pool');

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

            // Patch: Add operator_justification fields to scale_disconnection_logs
            if (checkDisconnectionTable.rows[0].exists) {
                const checkJustification = await client.query(`
                    SELECT column_name
                    FROM information_schema.columns
                    WHERE table_name = 'scale_disconnection_logs'
                    AND column_name = 'operator_justification'
                `);

                if (checkJustification.rows.length === 0) {
                    console.log('[Schema] 📝 Adding missing columns: scale_disconnection_logs.operator_justification, required_justification');
                    await client.query(`
                        ALTER TABLE scale_disconnection_logs
                        ADD COLUMN operator_justification TEXT,
                        ADD COLUMN required_justification BOOLEAN DEFAULT FALSE
                    `);
                    console.log('[Schema] ✅ Columns operator_justification + required_justification added successfully');
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

                // Patch: Add payment breakdown columns to ventas for mixed payments (mostrador)
                const checkVentasCashAmount = await client.query(`
                    SELECT column_name
                    FROM information_schema.columns
                    WHERE table_name = 'ventas'
                    AND column_name = 'cash_amount'
                `);

                if (checkVentasCashAmount.rows.length === 0) {
                    console.log('[Schema] 📝 Adding payment breakdown columns to ventas...');
                    await client.query(`
                        ALTER TABLE ventas
                        ADD COLUMN IF NOT EXISTS cash_amount DECIMAL(12, 2),
                        ADD COLUMN IF NOT EXISTS card_amount DECIMAL(12, 2),
                        ADD COLUMN IF NOT EXISTS credit_amount DECIMAL(12, 2)
                    `);
                    // Backfill: Para ventas no-mixtas, poner el total en la columna correspondiente
                    console.log('[Schema] 📝 Backfilling payment breakdown for existing ventas...');
                    // Efectivo (tipo_pago_id = 1): cash_amount = total
                    await client.query(`
                        UPDATE ventas SET cash_amount = total, card_amount = 0, credit_amount = 0
                        WHERE tipo_pago_id = 1 AND cash_amount IS NULL
                    `);
                    // Tarjeta (tipo_pago_id = 2): card_amount = total
                    await client.query(`
                        UPDATE ventas SET cash_amount = 0, card_amount = total, credit_amount = 0
                        WHERE tipo_pago_id = 2 AND card_amount IS NULL
                    `);
                    // Crédito (tipo_pago_id = 3): credit_amount = total
                    await client.query(`
                        UPDATE ventas SET cash_amount = 0, card_amount = 0, credit_amount = total
                        WHERE tipo_pago_id = 3 AND credit_amount IS NULL
                    `);
                    // Mixto (tipo_pago_id = 4): Intentar obtener de repartidor_assignments
                    await client.query(`
                        UPDATE ventas v
                        SET
                            cash_amount = COALESCE(ra.cash_amount, 0),
                            card_amount = COALESCE(ra.card_amount, 0),
                            credit_amount = COALESCE(ra.credit_amount, 0)
                        FROM repartidor_assignments ra
                        WHERE ra.venta_id = v.id_venta
                          AND v.tipo_pago_id = 4
                          AND v.cash_amount IS NULL
                    `);
                    // Para mixtos sin assignment, asumir todo efectivo como fallback
                    await client.query(`
                        UPDATE ventas SET cash_amount = monto_pagado, card_amount = 0, credit_amount = credito_original
                        WHERE tipo_pago_id = 4 AND cash_amount IS NULL
                    `);
                    console.log('[Schema] ✅ Payment breakdown columns added to ventas');
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

            // Patch: Add cajero_consolida_liquidaciones column to branches
            const checkBranchesCajeroConsolida = await client.query(`
                SELECT column_name FROM information_schema.columns
                WHERE table_name = 'branches' AND column_name = 'cajero_consolida_liquidaciones'
            `);
            if (checkBranchesCajeroConsolida.rows.length === 0) {
                console.log('[Schema] 📝 Adding missing column: branches.cajero_consolida_liquidaciones');
                await client.query(`
                    ALTER TABLE branches
                    ADD COLUMN IF NOT EXISTS cajero_consolida_liquidaciones BOOLEAN DEFAULT FALSE
                `);
                console.log('[Schema] ✅ branches.cajero_consolida_liquidaciones column added successfully');
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

            // Patch: Add socket_error columns to telemetry_events (error_reason, error_details, consecutive_failures)
            const checkErrorReasonCol = await client.query(`
                SELECT column_name FROM information_schema.columns
                WHERE table_name = 'telemetry_events' AND column_name = 'error_reason'
            `);
            if (checkErrorReasonCol.rows.length === 0) {
                console.log('[Schema] 📝 Adding socket_error columns to telemetry_events...');
                await client.query(`
                    ALTER TABLE telemetry_events
                        ADD COLUMN IF NOT EXISTS error_reason VARCHAR(100),
                        ADD COLUMN IF NOT EXISTS error_details TEXT,
                        ADD COLUMN IF NOT EXISTS consecutive_failures INTEGER;
                `);
                console.log('[Schema] ✅ Socket error columns added to telemetry_events');
            }

            // Patch: Widen DECIMAL columns in suspicious_weighing_logs to prevent "numeric field overflow"
            if (checkSuspiciousTable.rows[0].exists) {
                const checkColPrecision = await client.query(`
                    SELECT numeric_precision
                    FROM information_schema.columns
                    WHERE table_name = 'suspicious_weighing_logs'
                    AND column_name = 'weight_detected'
                `);
                const currentPrecision = checkColPrecision.rows.length > 0 ? checkColPrecision.rows[0].numeric_precision : 0;
                if (currentPrecision < 16) {
                    console.log(`[Schema] 📝 Widening DECIMAL columns in suspicious_weighing_logs (current precision: ${currentPrecision})...`);
                    await client.query(`
                        ALTER TABLE suspicious_weighing_logs
                            ALTER COLUMN weight_detected TYPE DECIMAL(16,3),
                            ALTER COLUMN employee_score_after_event TYPE DECIMAL(16,2),
                            ALTER COLUMN trust_score TYPE DECIMAL(16,2),
                            ALTER COLUMN cycle_duration_seconds TYPE DECIMAL(16,2),
                            ALTER COLUMN max_weight_in_cycle TYPE DECIMAL(16,3),
                            ALTER COLUMN discrepancy_amount TYPE DECIMAL(16,3)
                    `);
                    console.log('[Schema] ✅ suspicious_weighing_logs DECIMAL columns widened to (16,x)');
                }
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
                        (14, 'Otros', 'Otros gastos (usar Otros Gastos)', FALSE, NULL, 14)
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

            // Patch: Add group notification preference columns
            const checkGroupNotifCols = await client.query(`
                SELECT column_name FROM information_schema.columns
                WHERE table_name = 'notification_preferences' AND column_name = 'notify_turnos'
            `);
            if (checkGroupNotifCols.rows.length === 0) {
                console.log('[Schema] Adding group notification preference columns...');
                await client.query(`
                    ALTER TABLE notification_preferences
                        ADD COLUMN IF NOT EXISTS notify_turnos BOOLEAN DEFAULT true,
                        ADD COLUMN IF NOT EXISTS notify_ventas BOOLEAN DEFAULT true,
                        ADD COLUMN IF NOT EXISTS notify_gastos BOOLEAN DEFAULT true,
                        ADD COLUMN IF NOT EXISTS notify_repartidores BOOLEAN DEFAULT true,
                        ADD COLUMN IF NOT EXISTS notify_guardian BOOLEAN DEFAULT true
                `);
                await client.query(`
                    UPDATE notification_preferences SET
                        notify_turnos = (COALESCE(notify_login, true) AND COALESCE(notify_shift_start, true) AND COALESCE(notify_shift_end, true)),
                        notify_ventas = true,
                        notify_gastos = COALESCE(notify_expense_created, true),
                        notify_repartidores = COALESCE(notify_assignment_created, true),
                        notify_guardian = (COALESCE(notify_guardian_peso_no_registrado, true) AND COALESCE(notify_guardian_operacion_irregular, true) AND COALESCE(notify_guardian_discrepancia, true))
                `);
                console.log('[Schema] Group notification preference columns added and migrated');
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

            // Patch: Add image_url column to productos table
            try {
                await client.query(`ALTER TABLE productos ADD COLUMN IF NOT EXISTS image_url TEXT`);
                console.log('[Schema] ✅ Productos image_url column added');
            } catch (error) {
                console.log('[Schema] ⚠️ productos.image_url:', error.message);
            }

            // Patch: Add categoria_global_id column to productos table (relaciona con categorias_productos)
            try {
                await client.query(`ALTER TABLE productos ADD COLUMN IF NOT EXISTS categoria_global_id VARCHAR(255)`);
                console.log('[Schema] ✅ Productos categoria_global_id column added');
            } catch (error) {
                console.log('[Schema] ⚠️ productos.categoria_global_id:', error.message);
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
                        ADD COLUMN IF NOT EXISTS global_id VARCHAR(255),
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

                // Patch: Increase terminal_id column size in suppliers (was VARCHAR(50), now VARCHAR(100))
                const checkSupplierTerminalIdType = await client.query(`
                    SELECT character_maximum_length
                    FROM information_schema.columns
                    WHERE table_name = 'suppliers'
                    AND column_name = 'terminal_id'
                `);

                if (checkSupplierTerminalIdType.rows.length > 0) {
                    const currentLength = checkSupplierTerminalIdType.rows[0].character_maximum_length;
                    if (currentLength && currentLength < 100) {
                        console.log(`[Schema] 📝 Increasing suppliers.terminal_id from VARCHAR(${currentLength}) to VARCHAR(100)...`);
                        await client.query(`
                            ALTER TABLE suppliers
                            ALTER COLUMN terminal_id TYPE VARCHAR(100)
                        `);
                        console.log('[Schema] ✅ suppliers.terminal_id column size increased');
                    }
                }

                // Patch: Change suppliers.global_id from UUID to VARCHAR(255)
                // Seed data uses string IDs like "SEED_SUPPLIER_PRODUCTOS_PROPIOS_0" which are not valid UUIDs
                const checkSupplierGlobalIdType = await client.query(`
                    SELECT data_type FROM information_schema.columns
                    WHERE table_name = 'suppliers' AND column_name = 'global_id'
                `);
                if (checkSupplierGlobalIdType.rows.length > 0 && checkSupplierGlobalIdType.rows[0].data_type === 'uuid') {
                    console.log('[Schema] 📝 Changing suppliers.global_id from UUID to VARCHAR(255)...');
                    await client.query(`ALTER TABLE suppliers ALTER COLUMN global_id TYPE VARCHAR(255) USING global_id::text`);
                    console.log('[Schema] ✅ suppliers.global_id changed to VARCHAR(255)');
                }
            }

            // Patch: Create categorias_productos table if not exists
            console.log('[Schema] 🔍 Checking categorias_productos table...');
            const checkCategoriasTable = await client.query(`
                SELECT EXISTS (
                    SELECT FROM information_schema.tables
                    WHERE table_name = 'categorias_productos'
                )
            `);

            if (!checkCategoriasTable.rows[0].exists) {
                console.log('[Schema] 📝 Creating categorias_productos table...');
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

                console.log('[Schema] ✅ categorias_productos table created');
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

            // Patch: Add is_active to branch_devices for terminal naming (Migration 038)
            const checkBranchDevicesIsActive = await client.query(`
                SELECT column_name
                FROM information_schema.columns
                WHERE table_name = 'branch_devices' AND column_name = 'is_active'
            `);
            if (checkBranchDevicesIsActive.rows.length === 0) {
                console.log('[Schema] 📝 Adding is_active to branch_devices (terminal naming)...');
                await client.query(`ALTER TABLE branch_devices ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT TRUE`);
                await client.query(`
                    CREATE UNIQUE INDEX IF NOT EXISTS uq_branch_devices_name_active
                    ON branch_devices(branch_id, tenant_id, device_name)
                    WHERE is_active = TRUE AND device_name IS NOT NULL
                `);
                console.log('[Schema] ✅ branch_devices.is_active added');
            }

            // Patch: Ensure unique index on (device_id, branch_id, tenant_id) exists
            // Required for ON CONFLICT in auto-registration and claim-primary
            await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_branch_devices_unique ON branch_devices(device_id, branch_id, tenant_id)`);
            await client.query(`CREATE INDEX IF NOT EXISTS idx_branch_devices_branch ON branch_devices(branch_id, tenant_id)`);

            // Patch: Backfill branch_devices from existing shifts
            // Registers terminals that opened shifts before auto-registration was working
            const backfillCheck = await client.query(`SELECT COUNT(*) as cnt FROM branch_devices`);
            if (parseInt(backfillCheck.rows[0].cnt) === 0) {
                console.log('[Schema] 📝 Backfilling branch_devices from existing shifts...');
                const distinctTerminals = await client.query(`
                    SELECT DISTINCT terminal_id, branch_id, tenant_id
                    FROM shifts
                    WHERE terminal_id IS NOT NULL AND terminal_id != ''
                    ORDER BY branch_id, tenant_id
                `);
                let insertedCount = 0;
                // Group by branch+tenant to assign sequential names
                const branchGroups = {};
                for (const row of distinctTerminals.rows) {
                    const key = `${row.branch_id}_${row.tenant_id}`;
                    if (!branchGroups[key]) branchGroups[key] = [];
                    branchGroups[key].push(row);
                }
                for (const [, terminals] of Object.entries(branchGroups)) {
                    let cajaNum = 1;
                    for (const t of terminals) {
                        const deviceType = t.terminal_id.startsWith('mobile-') ? 'mobile' : 'desktop';
                        const name = `Caja ${cajaNum}`;
                        try {
                            await client.query(`
                                INSERT INTO branch_devices (tenant_id, branch_id, device_id, device_name, device_type, is_primary, last_seen_at, created_at, updated_at)
                                VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW(), NOW())
                                ON CONFLICT (device_id, branch_id, tenant_id) DO NOTHING
                            `, [t.tenant_id, t.branch_id, t.terminal_id, name, deviceType, cajaNum === 1]);
                            insertedCount++;
                            cajaNum++;
                        } catch (e) {
                            console.error(`[Schema] ⚠️ Backfill error for ${t.terminal_id}: ${e.message}`);
                        }
                    }
                }
                console.log(`[Schema] ✅ Backfilled ${insertedCount} terminals into branch_devices`);
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

            // Patch: Add weighing columns + fix severity logic for preparation_mode_logs
            console.log('[Schema] 🔍 Patching preparation_mode_logs (weighing data + inverted severity)...');
            try {
                // Add weighing cycle tracking columns
                await client.query(`ALTER TABLE preparation_mode_logs ADD COLUMN IF NOT EXISTS weighing_cycle_count INTEGER DEFAULT 0`);
                await client.query(`ALTER TABLE preparation_mode_logs ADD COLUMN IF NOT EXISTS total_weight_kg DECIMAL(10,3) DEFAULT 0`);
                await client.query(`ALTER TABLE preparation_mode_logs ADD COLUMN IF NOT EXISTS cycle_weights_json TEXT`);
                console.log('[Schema] ✅ Columnas weighing_cycle_count, total_weight_kg y cycle_weights_json verificadas');

                // Fix severity trigger: SHORT duration = suspicious (Critical), LONG = normal (Low)
                // In a tortillería, prep mode is used to prepare 30-50kg delivery orders
                // so long duration is expected. Short duration suggests Guardian bypass.
                await client.query(`
                    CREATE OR REPLACE FUNCTION calculate_prep_mode_severity()
                    RETURNS TRIGGER AS $$
                    BEGIN
                        IF NEW.duration_seconds IS NOT NULL THEN
                            IF NEW.duration_seconds < 60 THEN
                                NEW.severity = 'Critical';
                            ELSIF NEW.duration_seconds < 180 THEN
                                NEW.severity = 'High';
                            ELSIF NEW.duration_seconds < 600 THEN
                                NEW.severity = 'Medium';
                            ELSE
                                NEW.severity = 'Low';
                            END IF;
                        END IF;
                        RETURN NEW;
                    END;
                    $$ LANGUAGE plpgsql
                `);
                console.log('[Schema] ✅ Severidad de preparation_mode_logs invertida (corto=Critical, largo=Low)');

                // Recalculate severity for existing completed logs
                await client.query(`
                    UPDATE preparation_mode_logs SET severity =
                        CASE
                            WHEN duration_seconds < 60 THEN 'Critical'
                            WHEN duration_seconds < 180 THEN 'High'
                            WHEN duration_seconds < 600 THEN 'Medium'
                            ELSE 'Low'
                        END
                    WHERE duration_seconds IS NOT NULL
                `);
                console.log('[Schema] ✅ Severidades recalculadas para logs existentes');
            } catch (patchError) {
                console.log('[Schema] ⚠️ Patch preparation_mode_logs:', patchError.message);
            }

            // Patch: Alistamiento improvements (v2) - justification fields + time windows
            console.log('[Schema] 🔍 Patching preparation_mode_logs (alistamiento v2)...');
            try {
                await client.query(`ALTER TABLE preparation_mode_logs ADD COLUMN IF NOT EXISTS fuera_de_ventana BOOLEAN DEFAULT FALSE`);
                await client.query(`ALTER TABLE preparation_mode_logs ADD COLUMN IF NOT EXISTS razon_activacion TEXT`);
                await client.query(`ALTER TABLE preparation_mode_logs ADD COLUMN IF NOT EXISTS razon_cierre TEXT`);
                await client.query(`ALTER TABLE preparation_mode_logs ADD COLUMN IF NOT EXISTS requirio_justificacion_activacion BOOLEAN DEFAULT FALSE`);
                await client.query(`ALTER TABLE preparation_mode_logs ADD COLUMN IF NOT EXISTS requirio_justificacion_cierre BOOLEAN DEFAULT FALSE`);
                await client.query(`ALTER TABLE preparation_mode_logs ADD COLUMN IF NOT EXISTS notificacion_enviada BOOLEAN DEFAULT FALSE`);
                console.log('[Schema] ✅ Campos de alistamiento v2 verificados en preparation_mode_logs');

                // Create preparation_mode_windows table
                await client.query(`
                    CREATE TABLE IF NOT EXISTS preparation_mode_windows (
                        id SERIAL PRIMARY KEY,
                        tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
                        branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
                        name VARCHAR(100) NOT NULL,
                        start_time TIME NOT NULL,
                        end_time TIME NOT NULL,
                        is_active BOOLEAN DEFAULT TRUE,
                        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
                        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
                    )
                `);
                await client.query(`CREATE INDEX IF NOT EXISTS idx_prep_windows_tenant_branch ON preparation_mode_windows(tenant_id, branch_id)`);
                console.log('[Schema] ✅ Tabla preparation_mode_windows verificada');
            } catch (patchError) {
                console.log('[Schema] ⚠️ Patch alistamiento v2:', patchError.message);
            }

            // 3. Always run seeds (idempotent - uses ON CONFLICT)
            console.log('[Seeds] 📝 Running seeds.sql...');
            const seedsPath = path.join(__dirname, '..', 'seeds.sql');
            if (fs.existsSync(seedsPath)) {
                const seedsSql = fs.readFileSync(seedsPath, 'utf8');
                await client.query('BEGIN');
                await client.query(seedsSql);
                await client.query('COMMIT');
                console.log('[Seeds] ✅ Seeds applied successfully');
            } else {
                console.error('[Seeds] ❌ seeds.sql not found!');
            }

            // Patch: Create notas_credito tables if missing (Migration 016)
            console.log('[Schema] 🔍 Checking notas_credito table...');
            const checkNotasCreditoTable = await client.query(`
                SELECT EXISTS (
                    SELECT FROM information_schema.tables
                    WHERE table_name = 'notas_credito'
                )
            `);

            if (!checkNotasCreditoTable.rows[0].exists) {
                console.log('[Schema] 📝 Creating tables: notas_credito, notas_credito_detalle (Migration 016)');

                // Add has_nota_credito column to ventas if not exists
                await client.query(`ALTER TABLE ventas ADD COLUMN IF NOT EXISTS has_nota_credito BOOLEAN DEFAULT FALSE`);

                // Create notas_credito table
                await client.query(`
                    CREATE TABLE notas_credito (
                        id SERIAL PRIMARY KEY,
                        venta_original_id INTEGER NOT NULL REFERENCES ventas(id_venta),
                        shift_id INTEGER NOT NULL REFERENCES shifts(id),
                        employee_id INTEGER NOT NULL REFERENCES employees(id),
                        authorized_by_id INTEGER NOT NULL REFERENCES employees(id),
                        cliente_id INTEGER REFERENCES customers(id),
                        tenant_id INTEGER NOT NULL REFERENCES tenants(id),
                        branch_id INTEGER NOT NULL REFERENCES branches(id),
                        tipo VARCHAR(50) NOT NULL DEFAULT 'Cancelacion',
                        estado VARCHAR(50) NOT NULL DEFAULT 'Aplicada',
                        total DECIMAL(12,2) NOT NULL,
                        monto_credito DECIMAL(12,2) DEFAULT 0,
                        monto_efectivo DECIMAL(12,2) DEFAULT 0,
                        monto_tarjeta DECIMAL(12,2) DEFAULT 0,
                        fecha_creacion TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
                        fecha_venta_original TIMESTAMP WITH TIME ZONE,
                        razon VARCHAR(500) NOT NULL,
                        notas TEXT,
                        numero_nota_credito VARCHAR(50),
                        ticket_original INTEGER,
                        global_id VARCHAR(36) NOT NULL UNIQUE,
                        terminal_id VARCHAR(50),
                        local_op_seq INTEGER DEFAULT 0,
                        device_event_raw BIGINT DEFAULT 0,
                        created_local_utc TIMESTAMP WITH TIME ZONE,
                        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
                    )
                `);

                // Create notas_credito_detalle table
                await client.query(`
                    CREATE TABLE notas_credito_detalle (
                        id SERIAL PRIMARY KEY,
                        nota_credito_id INTEGER NOT NULL REFERENCES notas_credito(id) ON DELETE CASCADE,
                        venta_detalle_original_id INTEGER REFERENCES ventas_detalle(id_venta_detalle),
                        producto_id INTEGER NOT NULL REFERENCES productos(id),
                        descripcion_producto VARCHAR(255) NOT NULL,
                        cantidad DECIMAL(12,3) NOT NULL,
                        cantidad_original DECIMAL(12,3) DEFAULT 0,
                        precio_unitario DECIMAL(12,2) NOT NULL,
                        total_linea DECIMAL(12,2) NOT NULL,
                        devuelve_a_inventario BOOLEAN DEFAULT TRUE,
                        kardex_movimiento_id INTEGER,
                        global_id VARCHAR(36) NOT NULL UNIQUE,
                        terminal_id VARCHAR(50),
                        local_op_seq INTEGER DEFAULT 0,
                        device_event_raw BIGINT DEFAULT 0,
                        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
                    )
                `);

                // Create indexes
                await client.query(`CREATE INDEX IF NOT EXISTS idx_notas_credito_tenant ON notas_credito(tenant_id)`);
                await client.query(`CREATE INDEX IF NOT EXISTS idx_notas_credito_branch ON notas_credito(branch_id)`);
                await client.query(`CREATE INDEX IF NOT EXISTS idx_notas_credito_venta ON notas_credito(venta_original_id)`);
                await client.query(`CREATE INDEX IF NOT EXISTS idx_notas_credito_cliente ON notas_credito(cliente_id)`);
                await client.query(`CREATE INDEX IF NOT EXISTS idx_notas_credito_fecha ON notas_credito(fecha_creacion DESC)`);
                await client.query(`CREATE INDEX IF NOT EXISTS idx_notas_credito_global_id ON notas_credito(global_id)`);
                await client.query(`CREATE INDEX IF NOT EXISTS idx_nc_detalle_nota ON notas_credito_detalle(nota_credito_id)`);
                await client.query(`CREATE INDEX IF NOT EXISTS idx_nc_detalle_producto ON notas_credito_detalle(producto_id)`);
                await client.query(`CREATE INDEX IF NOT EXISTS idx_nc_detalle_global_id ON notas_credito_detalle(global_id)`);

                console.log('[Schema] ✅ Tables notas_credito and notas_credito_detalle created successfully');
            }

            // Patch: Create triggers for NC balance and inventory (Migration 018)
            console.log('[Schema] 🔍 Checking NC triggers...');
            const checkNCTrigger = await client.query(`
                SELECT EXISTS (
                    SELECT FROM pg_trigger WHERE tgname = 'trigger_update_balance_on_nota_credito'
                )
            `);

            if (!checkNCTrigger.rows[0].exists) {
                console.log('[Schema] 📝 Creating NC triggers for balance and inventory (Migration 018)');

                // Trigger: Update customer balance on NC
                await client.query(`
                    CREATE OR REPLACE FUNCTION update_customer_balance_on_nota_credito()
                    RETURNS TRIGGER AS $$
                    DECLARE
                        v_tipo_pago_id INTEGER;
                    BEGIN
                        IF NEW.estado = 'Aplicada' AND NEW.cliente_id IS NOT NULL THEN
                            SELECT tipo_pago_id INTO v_tipo_pago_id FROM ventas WHERE id_venta = NEW.venta_original_id;
                            IF v_tipo_pago_id = 3 THEN
                                UPDATE customers SET saldo_deudor = GREATEST(saldo_deudor - NEW.total, 0), updated_at = CURRENT_TIMESTAMP WHERE id = NEW.cliente_id;
                            END IF;
                            IF NEW.monto_credito > 0 AND v_tipo_pago_id != 3 THEN
                                UPDATE customers SET saldo_deudor = GREATEST(saldo_deudor - NEW.monto_credito, 0), updated_at = CURRENT_TIMESTAMP WHERE id = NEW.cliente_id;
                            END IF;
                        END IF;
                        RETURN NEW;
                    END;
                    $$ LANGUAGE plpgsql
                `);
                await client.query(`DROP TRIGGER IF EXISTS trigger_update_balance_on_nota_credito ON notas_credito`);
                await client.query(`CREATE TRIGGER trigger_update_balance_on_nota_credito AFTER INSERT ON notas_credito FOR EACH ROW EXECUTE FUNCTION update_customer_balance_on_nota_credito()`);

                // Trigger: Update inventory on NC detail
                await client.query(`
                    CREATE OR REPLACE FUNCTION update_inventory_on_nota_credito_detalle()
                    RETURNS TRIGGER AS $$
                    DECLARE
                        v_tenant_id INTEGER;
                    BEGIN
                        IF NEW.devuelve_a_inventario = TRUE THEN
                            SELECT tenant_id INTO v_tenant_id FROM notas_credito WHERE id = NEW.nota_credito_id;
                            UPDATE productos SET inventario = inventario + NEW.cantidad, updated_at = CURRENT_TIMESTAMP WHERE id = NEW.producto_id AND tenant_id = v_tenant_id;
                        END IF;
                        RETURN NEW;
                    END;
                    $$ LANGUAGE plpgsql
                `);
                await client.query(`DROP TRIGGER IF EXISTS trigger_update_inventory_on_nc_detalle ON notas_credito_detalle`);
                await client.query(`CREATE TRIGGER trigger_update_inventory_on_nc_detalle AFTER INSERT ON notas_credito_detalle FOR EACH ROW EXECUTE FUNCTION update_inventory_on_nota_credito_detalle()`);

                // Trigger: Revert balance on NC cancellation
                await client.query(`
                    CREATE OR REPLACE FUNCTION revert_customer_balance_on_nc_cancel()
                    RETURNS TRIGGER AS $$
                    DECLARE
                        v_tipo_pago_id INTEGER;
                    BEGIN
                        IF OLD.estado = 'Aplicada' AND NEW.estado = 'Anulada' AND NEW.cliente_id IS NOT NULL THEN
                            SELECT tipo_pago_id INTO v_tipo_pago_id FROM ventas WHERE id_venta = NEW.venta_original_id;
                            IF v_tipo_pago_id = 3 THEN
                                UPDATE customers SET saldo_deudor = saldo_deudor + NEW.total, updated_at = CURRENT_TIMESTAMP WHERE id = NEW.cliente_id;
                            END IF;
                            IF NEW.monto_credito > 0 AND v_tipo_pago_id != 3 THEN
                                UPDATE customers SET saldo_deudor = saldo_deudor + NEW.monto_credito, updated_at = CURRENT_TIMESTAMP WHERE id = NEW.cliente_id;
                            END IF;
                        END IF;
                        RETURN NEW;
                    END;
                    $$ LANGUAGE plpgsql
                `);
                await client.query(`DROP TRIGGER IF EXISTS trigger_revert_balance_on_nc_cancel ON notas_credito`);
                await client.query(`CREATE TRIGGER trigger_revert_balance_on_nc_cancel AFTER UPDATE ON notas_credito FOR EACH ROW WHEN (OLD.estado IS DISTINCT FROM NEW.estado) EXECUTE FUNCTION revert_customer_balance_on_nc_cancel()`);

                console.log('[Schema] ✅ NC triggers created successfully');
            }

            // Patch: Add receipt_image column to expenses (Migration 019)
            console.log('[Schema] 🔍 Checking expenses.receipt_image column...');
            const checkReceiptImage = await client.query(`
                SELECT column_name
                FROM information_schema.columns
                WHERE table_name = 'expenses'
                AND column_name = 'receipt_image'
            `);

            if (checkReceiptImage.rows.length === 0) {
                console.log('[Schema] 📝 Adding expenses.receipt_image column (Migration 019)...');
                await client.query(`
                    ALTER TABLE expenses
                    ADD COLUMN receipt_image TEXT
                `);
                await client.query(`
                    COMMENT ON COLUMN expenses.receipt_image IS 'Imagen del recibo en Base64 (JPEG comprimido). Max recomendado: 500KB'
                `);
                await client.query(`
                    CREATE INDEX IF NOT EXISTS idx_expenses_has_receipt
                    ON expenses(id)
                    WHERE receipt_image IS NOT NULL
                `);
                console.log('[Schema] ✅ expenses.receipt_image column added successfully');
            }

            // Patch: Seed all 20 system permissions and default role_permissions (Migration 020)
            // The permissions table is system-controlled and uses 'code' as natural key
            console.log('[Schema] 🔍 Checking system permissions completeness (Migration 020)...');

            const currentPermCount = await client.query(`SELECT COUNT(*) as cnt FROM permissions`);
            const permCount = parseInt(currentPermCount.rows[0].cnt);

            // Also check if IDs are in the correct order (AccessPointOfSale should be ID 1)
            const idCheck = await client.query(`SELECT id FROM permissions WHERE code = 'AccessPointOfSale'`);
            const needsReorder = idCheck.rows.length > 0 && idCheck.rows[0].id !== 1;

            if (permCount < 20 || needsReorder) {
                console.log(`[Schema] 📝 Seeding system permissions (currently ${permCount}, reorder=${needsReorder})...`);

                // Delete existing permissions and role_permissions to re-insert with correct IDs
                // IDs MUST match local SQLite order (1-20) for consistency across platforms
                if (permCount > 0) {
                    console.log(`[Schema] 🔄 Cleaning existing ${permCount} permissions to re-insert with correct IDs...`);
                    await client.query(`DELETE FROM role_permissions`);
                    await client.query(`DELETE FROM permissions`);
                }

                // Insert all 20 system permissions with explicit IDs matching SQLite local
                await client.query(`
                    INSERT INTO permissions (id, code, name, description, category) VALUES
                    (1,  'AccessPointOfSale',           'Acceso al Punto de Venta',     'Permite realizar ventas desde el punto de venta principal', 'ventas'),
                    (2,  'SettleDeliveries',            'Liquidar Repartidores',        'Permite realizar la liquidación de las ventas de un repartidor', 'repartidores'),
                    (3,  'ManageCashDrawer',            'Gestionar Caja',               'Permite registrar ingresos y retiros de efectivo en la caja', 'caja'),
                    (4,  'ManageProducts',              'Gestionar Productos',          'Permite crear, editar y eliminar productos del catálogo', 'inventario'),
                    (5,  'ManageCustomers',             'Gestionar Clientes',           'Permite crear, editar y gestionar la información de los clientes', 'clientes'),
                    (6,  'ManageSuppliers',             'Gestionar Proveedores',        'Permite crear, editar y gestionar la información de los proveedores', 'compras'),
                    (7,  'ManagePurchases',             'Gestionar Compras',            'Permite registrar las compras de materia prima a proveedores', 'compras'),
                    (8,  'ManageExpenses',              'Gestionar Gastos',             'Permite registrar gastos operativos del negocio', 'gastos'),
                    (9,  'ViewDashboard',               'Ver Dashboard',                'Permite ver el panel de control con las métricas generales del negocio', 'reportes'),
                    (10, 'ManageCashCuts',              'Gestionar Cortes de Caja',     'Permite realizar y consultar los cortes de caja', 'caja'),
                    (11, 'ViewScaleAudits',             'Ver Auditorías de Báscula',    'Permite acceder al registro de auditoría de la báscula', 'seguridad'),
                    (12, 'ManageEmployees',             'Gestionar Empleados',          'Permite crear, editar y gestionar los usuarios y sus roles', 'administracion'),
                    (13, 'AccessSettings',              'Acceso a Configuración',       'Permite acceder y modificar la configuración general del sistema', 'administracion'),
                    (14, 'ActivatePreparationMode',     'Activar Modo Preparación',     'Permite activar Peso de Alistamiento para pesar producto sin generar alertas', 'produccion'),
                    (15, 'AccessMobileAppAsAdmin',      'Acceso Móvil Admin',           'Acceso a la aplicación móvil con permisos de Administrador', 'movil'),
                    (16, 'AccessMobileAppAsDistributor', 'Acceso Móvil Repartidor',     'Acceso a la aplicación móvil con permisos de Repartidor', 'movil'),
                    (17, 'CloseApplication',            'Cerrar Aplicación',            'Permite cerrar la aplicación', 'administracion'),
                    (18, 'ManageProduction',            'Gestionar Producción',         'Permite acceder a la bitácora, configuración y alertas del módulo de producción', 'produccion'),
                    (19, 'AccessProduction',            'Acceso a Producción',          'Permite acceder al módulo de Producción para registrar peso de masa', 'produccion'),
                    (20, 'ManualWeightOverride',        'Peso Manual',                  'Permite ingresar peso manualmente aún con la báscula conectada', 'produccion'),
                    (21, 'CanTransferInventory',       'Transferir Inventario',        'Permite transferir inventario entre sucursales', 'inventario')
                `);

                // Reset sequence so next auto-generated ID is 22
                await client.query(`SELECT setval('permissions_id_seq', 21, true)`);

                // Seed default role_permissions for all tenant system roles
                // Administrador → ALL permissions
                await client.query(`
                    INSERT INTO role_permissions (role_id, permission_id)
                    SELECT r.id, p.id
                    FROM roles r
                    CROSS JOIN permissions p
                    WHERE r.is_system = true AND r.name = 'Administrador'
                    ON CONFLICT (role_id, permission_id) DO NOTHING
                `);

                // Encargado → specific permissions
                await client.query(`
                    INSERT INTO role_permissions (role_id, permission_id)
                    SELECT r.id, p.id
                    FROM roles r
                    CROSS JOIN permissions p
                    WHERE r.is_system = true AND r.name = 'Encargado'
                    AND p.code IN (
                        'AccessPointOfSale', 'SettleDeliveries', 'ManageCashDrawer',
                        'ManageExpenses', 'ManageCustomers', 'ManageProducts',
                        'ManageCashCuts', 'AccessProduction', 'ManageProduction'
                    )
                    ON CONFLICT (role_id, permission_id) DO NOTHING
                `);

                // Repartidor → AccessPointOfSale only
                await client.query(`
                    INSERT INTO role_permissions (role_id, permission_id)
                    SELECT r.id, p.id
                    FROM roles r
                    CROSS JOIN permissions p
                    WHERE r.is_system = true AND r.name = 'Repartidor'
                    AND p.code IN ('AccessPointOfSale')
                    ON CONFLICT (role_id, permission_id) DO NOTHING
                `);

                // Ayudante → AccessPointOfSale, AccessProduction
                await client.query(`
                    INSERT INTO role_permissions (role_id, permission_id)
                    SELECT r.id, p.id
                    FROM roles r
                    CROSS JOIN permissions p
                    WHERE r.is_system = true AND r.name = 'Ayudante'
                    AND p.code IN ('AccessPointOfSale', 'AccessProduction')
                    ON CONFLICT (role_id, permission_id) DO NOTHING
                `);

                // Cajero → specific permissions (if role exists)
                await client.query(`
                    INSERT INTO role_permissions (role_id, permission_id)
                    SELECT r.id, p.id
                    FROM roles r
                    CROSS JOIN permissions p
                    WHERE r.is_system = true AND r.name = 'Cajero'
                    AND p.code IN ('AccessPointOfSale', 'SettleDeliveries', 'ManageExpenses', 'AccessProduction')
                    ON CONFLICT (role_id, permission_id) DO NOTHING
                `);

                // Derive mobile_access_type from permissions for all roles
                await client.query(`
                    UPDATE roles r SET mobile_access_type =
                        CASE
                            WHEN EXISTS (
                                SELECT 1 FROM role_permissions rp
                                JOIN permissions p ON rp.permission_id = p.id
                                WHERE rp.role_id = r.id AND p.code = 'AccessMobileAppAsAdmin'
                            ) THEN 'admin'
                            WHEN EXISTS (
                                SELECT 1 FROM role_permissions rp
                                JOIN permissions p ON rp.permission_id = p.id
                                WHERE rp.role_id = r.id AND p.code = 'AccessMobileAppAsDistributor'
                            ) THEN 'distributor'
                            ELSE 'none'
                        END
                `);

                // Update the trigger function to seed all permissions for new tenants
                await client.query(`
                    CREATE OR REPLACE FUNCTION seed_default_roles_for_tenant()
                    RETURNS TRIGGER AS $$
                    BEGIN
                        -- Insert default roles
                        INSERT INTO roles (tenant_id, name, description, is_system, mobile_access_type)
                        VALUES
                            (NEW.id, 'Administrador', 'Acceso total al sistema', true, 'admin'),
                            (NEW.id, 'Encargado', 'Gerente de turno - permisos extensos', true, 'none'),
                            (NEW.id, 'Repartidor', 'Acceso limitado como repartidor', true, 'distributor'),
                            (NEW.id, 'Ayudante', 'Soporte - acceso limitado', true, 'none'),
                            (NEW.id, 'Cajero', 'Ventas, liquidaciones y producción', true, 'cashier');

                        -- Administrador gets ALL permissions
                        INSERT INTO role_permissions (role_id, permission_id)
                        SELECT r.id, p.id
                        FROM roles r CROSS JOIN permissions p
                        WHERE r.tenant_id = NEW.id AND r.name = 'Administrador';

                        -- Encargado gets specific permissions
                        INSERT INTO role_permissions (role_id, permission_id)
                        SELECT r.id, p.id
                        FROM roles r CROSS JOIN permissions p
                        WHERE r.tenant_id = NEW.id AND r.name = 'Encargado'
                        AND p.code IN (
                            'AccessPointOfSale', 'SettleDeliveries', 'ManageCashDrawer',
                            'ManageExpenses', 'ManageCustomers', 'ManageProducts',
                            'ManageCashCuts', 'AccessProduction', 'ManageProduction'
                        );

                        -- Repartidor gets AccessPointOfSale
                        INSERT INTO role_permissions (role_id, permission_id)
                        SELECT r.id, p.id
                        FROM roles r CROSS JOIN permissions p
                        WHERE r.tenant_id = NEW.id AND r.name = 'Repartidor'
                        AND p.code = 'AccessPointOfSale';

                        -- Ayudante gets AccessPointOfSale, AccessProduction
                        INSERT INTO role_permissions (role_id, permission_id)
                        SELECT r.id, p.id
                        FROM roles r CROSS JOIN permissions p
                        WHERE r.tenant_id = NEW.id AND r.name = 'Ayudante'
                        AND p.code IN ('AccessPointOfSale', 'AccessProduction');

                        -- Cajero gets POS, liquidaciones, gastos, producción
                        INSERT INTO role_permissions (role_id, permission_id)
                        SELECT r.id, p.id
                        FROM roles r CROSS JOIN permissions p
                        WHERE r.tenant_id = NEW.id AND r.name = 'Cajero'
                        AND p.code IN ('AccessPointOfSale', 'SettleDeliveries', 'ManageExpenses', 'AccessProduction');

                        RETURN NEW;
                    END;
                    $$ LANGUAGE plpgsql
                `);

                const finalPermCount = await client.query(`SELECT COUNT(*) as cnt FROM permissions`);
                const finalRpCount = await client.query(`SELECT COUNT(*) as cnt FROM role_permissions`);
                console.log(`[Schema] ✅ System permissions seeded: ${finalPermCount.rows[0].cnt} permissions, ${finalRpCount.rows[0].cnt} role_permissions`);
            } else {
                console.log(`[Schema] ℹ️ Permissions already complete (${permCount} permissions found)`);
            }

            // ═══════════════════════════════════════════════════════════════
            // Migration 021: device_tokens - crear tabla si no existe + agregar email
            // ═══════════════════════════════════════════════════════════════
            console.log('[Schema] 🔍 Checking device_tokens table (Migration 021)...');
            try {
                // Crear tabla si no existe (antes se hacía con script manual)
                await client.query(`
                    CREATE TABLE IF NOT EXISTS device_tokens (
                        id SERIAL PRIMARY KEY,
                        employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
                        branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
                        device_token TEXT NOT NULL UNIQUE,
                        platform VARCHAR(50) NOT NULL,
                        device_name VARCHAR(255),
                        device_id VARCHAR(255),
                        email VARCHAR(255),
                        is_active BOOLEAN DEFAULT true,
                        last_used_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    )
                `);
                // Agregar columnas que podrían faltar en tablas existentes
                await client.query(`ALTER TABLE device_tokens ADD COLUMN IF NOT EXISTS email VARCHAR(255)`);
                await client.query(`ALTER TABLE device_tokens ADD COLUMN IF NOT EXISTS device_id VARCHAR(255)`);
                await client.query(`ALTER TABLE device_tokens ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`);
                // Índices
                await client.query(`CREATE INDEX IF NOT EXISTS idx_device_tokens_employee_id ON device_tokens(employee_id)`);
                await client.query(`CREATE INDEX IF NOT EXISTS idx_device_tokens_branch_id ON device_tokens(branch_id)`);
                await client.query(`CREATE INDEX IF NOT EXISTS idx_device_tokens_is_active ON device_tokens(is_active)`);
                await client.query(`CREATE INDEX IF NOT EXISTS idx_device_tokens_device_id ON device_tokens(device_id)`);
                await client.query(`CREATE INDEX IF NOT EXISTS idx_device_tokens_email ON device_tokens(email)`);
                console.log('[Schema] ✅ device_tokens table ready');
            } catch (dtErr) {
                console.error(`[Schema] ⚠️ device_tokens migration error: ${dtErr.message}`);
            }

            // ═══════════════════════════════════════════════════════════════
            // Migration 022: beta_enrollments - registro de interés en app móvil beta
            // ═══════════════════════════════════════════════════════════════
            console.log('[Schema] 🔍 Checking beta_enrollments table (Migration 022)...');
            try {
                await client.query(`
                    CREATE TABLE IF NOT EXISTS beta_enrollments (
                        id SERIAL PRIMARY KEY,
                        tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
                        employee_id INTEGER,
                        email VARCHAR(255) NOT NULL,
                        business_name VARCHAR(255),
                        platform VARCHAR(20) DEFAULT 'both',
                        enrolled_at TIMESTAMPTZ DEFAULT NOW(),
                        UNIQUE(tenant_id)
                    )
                `);
                // Add platform column if table already existed without it
                await client.query(`
                    ALTER TABLE beta_enrollments ADD COLUMN IF NOT EXISTS platform VARCHAR(20) DEFAULT 'both'
                `);
                console.log('[Schema] ✅ beta_enrollments table ready');
            } catch (beErr) {
                console.error(`[Schema] ⚠️ beta_enrollments migration error: ${beErr.message}`);
            }

            // Patch: Add liquidaciones columns to cash_cuts (for consolidated repartidor liquidations in cash cuts)
            console.log('[Schema] 🔍 Checking cash_cuts liquidaciones columns...');
            const checkCashCutsTable = await client.query(`
                SELECT EXISTS (
                    SELECT FROM information_schema.tables
                    WHERE table_name = 'cash_cuts'
                )
            `);
            if (checkCashCutsTable.rows[0].exists) {
                const checkLiquidacionesCol = await client.query(`
                    SELECT column_name
                    FROM information_schema.columns
                    WHERE table_name = 'cash_cuts'
                    AND column_name = 'total_liquidaciones_efectivo'
                `);
                if (checkLiquidacionesCol.rows.length === 0) {
                    console.log('[Schema] 📝 Adding liquidaciones columns to cash_cuts...');
                    await client.query(`
                        ALTER TABLE cash_cuts
                        ADD COLUMN IF NOT EXISTS total_liquidaciones_efectivo DECIMAL(12, 2) DEFAULT 0,
                        ADD COLUMN IF NOT EXISTS total_liquidaciones_tarjeta DECIMAL(12, 2) DEFAULT 0,
                        ADD COLUMN IF NOT EXISTS total_liquidaciones_credito DECIMAL(12, 2) DEFAULT 0
                    `);
                    console.log('[Schema] ✅ cash_cuts liquidaciones columns added successfully');
                }

                // Agregar columna de gastos de repartidores a cash_cuts
                const checkRepExpCol = await client.query(`
                    SELECT column_name
                    FROM information_schema.columns
                    WHERE table_name = 'cash_cuts'
                    AND column_name = 'total_repartidor_expenses'
                `);
                if (checkRepExpCol.rows.length === 0) {
                    console.log('[Schema] 📝 Adding total_repartidor_expenses column to cash_cuts...');
                    await client.query(`
                        ALTER TABLE cash_cuts
                        ADD COLUMN IF NOT EXISTS total_repartidor_expenses DECIMAL(12, 2) DEFAULT 0
                    `);
                    console.log('[Schema] ✅ cash_cuts total_repartidor_expenses column added successfully');
                }

                // Patch: Indicadores de consolidación CajeroConsolida (para app móvil)
                const checkConsolidaCol = await client.query(`
                    SELECT column_name
                    FROM information_schema.columns
                    WHERE table_name = 'cash_cuts'
                    AND column_name = 'has_consolidated_liquidaciones'
                `);
                if (checkConsolidaCol.rows.length === 0) {
                    console.log('[Schema] 📝 Adding consolidation indicator columns to cash_cuts...');
                    await client.query(`
                        ALTER TABLE cash_cuts
                        ADD COLUMN IF NOT EXISTS has_consolidated_liquidaciones BOOLEAN DEFAULT FALSE,
                        ADD COLUMN IF NOT EXISTS consolidated_repartidor_names TEXT
                    `);
                    console.log('[Schema] ✅ cash_cuts consolidation columns added successfully');
                }
            }

            // Patch: Create branch_inventory table for inter-branch transfer tracking
            try {
                await client.query(`
                    CREATE TABLE IF NOT EXISTS branch_inventory (
                        id SERIAL PRIMARY KEY,
                        tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
                        branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
                        producto_id INTEGER NOT NULL REFERENCES productos(id) ON DELETE CASCADE,
                        quantity NUMERIC(12, 2) DEFAULT 0,
                        minimum NUMERIC(12, 2) DEFAULT 0,
                        updated_at TIMESTAMP DEFAULT NOW(),
                        UNIQUE(tenant_id, branch_id, producto_id)
                    )
                `);
                console.log('[Schema] ✅ branch_inventory table ready');
            } catch (biErr) {
                console.error(`[Schema] ⚠️ branch_inventory migration error: ${biErr.message}`);
            }

            // Patch: Create inventory_transfers + items tables
            try {
                await client.query(`
                    CREATE TABLE IF NOT EXISTS inventory_transfers (
                        id SERIAL PRIMARY KEY,
                        tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
                        from_branch_id INTEGER NOT NULL REFERENCES branches(id),
                        to_branch_id INTEGER NOT NULL REFERENCES branches(id),
                        status VARCHAR(20) DEFAULT 'completed',
                        notes TEXT,
                        created_by_employee_id INTEGER REFERENCES employees(id),
                        global_id VARCHAR(255) UNIQUE,
                        terminal_id VARCHAR(100),
                        created_at TIMESTAMP DEFAULT NOW()
                    )
                `);
                await client.query(`
                    CREATE TABLE IF NOT EXISTS inventory_transfer_items (
                        id SERIAL PRIMARY KEY,
                        transfer_id INTEGER NOT NULL REFERENCES inventory_transfers(id) ON DELETE CASCADE,
                        producto_id INTEGER NOT NULL REFERENCES productos(id),
                        product_name VARCHAR(255),
                        quantity NUMERIC(12, 2) NOT NULL,
                        unit_abbreviation VARCHAR(20) DEFAULT 'kg',
                        producto_global_id VARCHAR(255)
                    )
                `);
                console.log('[Schema] ✅ inventory_transfers + items tables ready');

                // Add stock tracking columns (before/after per branch)
                try {
                    await client.query(`
                        ALTER TABLE inventory_transfer_items
                            ADD COLUMN IF NOT EXISTS stock_before_source NUMERIC(12, 2),
                            ADD COLUMN IF NOT EXISTS stock_after_source NUMERIC(12, 2),
                            ADD COLUMN IF NOT EXISTS stock_before_target NUMERIC(12, 2),
                            ADD COLUMN IF NOT EXISTS stock_after_target NUMERIC(12, 2)
                    `);
                } catch (colErr) {
                    // Columns might already exist
                }
                console.log('[Schema] ✅ stock tracking columns ready');
            } catch (itErr) {
                console.error(`[Schema] ⚠️ inventory_transfers migration error: ${itErr.message}`);
            }

            // Patch: Add CanTransferInventory permission for inter-branch transfers
            try {
                const permCheck = await client.query(
                    `SELECT id FROM permissions WHERE code = 'CanTransferInventory'`
                );
                if (permCheck.rows.length === 0) {
                    console.log('[Schema] 📝 Adding CanTransferInventory permission...');
                    await client.query(`
                        INSERT INTO permissions (code, name, description, category)
                        VALUES ('CanTransferInventory', 'Transferir Inventario', 'Permite transferir inventario entre sucursales', 'inventario')
                    `);
                    // Assign to all Administrador roles
                    await client.query(`
                        INSERT INTO role_permissions (role_id, permission_id)
                        SELECT r.id, p.id
                        FROM roles r
                        CROSS JOIN permissions p
                        WHERE r.is_system = true AND r.name = 'Administrador'
                        AND p.code = 'CanTransferInventory'
                        ON CONFLICT (role_id, permission_id) DO NOTHING
                    `);
                    console.log('[Schema] ✅ CanTransferInventory permission added and assigned to admins');
                }
            } catch (permErr) {
                console.error(`[Schema] ⚠️ CanTransferInventory migration error: ${permErr.message}`);
            }

            // Patch: GPS tracking tables for repartidores (028)
            try {
                await client.query(`
                    CREATE TABLE IF NOT EXISTS repartidor_locations (
                        id BIGSERIAL PRIMARY KEY,
                        tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
                        branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
                        employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
                        shift_id INTEGER,
                        latitude DOUBLE PRECISION NOT NULL,
                        longitude DOUBLE PRECISION NOT NULL,
                        accuracy DOUBLE PRECISION,
                        speed DOUBLE PRECISION,
                        heading DOUBLE PRECISION,
                        recorded_at TIMESTAMPTZ NOT NULL,
                        received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        CONSTRAINT chk_latitude CHECK (latitude BETWEEN -90 AND 90),
                        CONSTRAINT chk_longitude CHECK (longitude BETWEEN -180 AND 180)
                    )
                `);
                await client.query(`CREATE INDEX IF NOT EXISTS idx_repartidor_locations_branch_employee ON repartidor_locations (branch_id, employee_id, received_at DESC)`);
                await client.query(`CREATE INDEX IF NOT EXISTS idx_repartidor_locations_employee_date ON repartidor_locations (employee_id, recorded_at DESC)`);
                await client.query(`CREATE INDEX IF NOT EXISTS idx_repartidor_locations_retention ON repartidor_locations (received_at)`);
                await client.query(`CREATE INDEX IF NOT EXISTS idx_repartidor_locations_tenant ON repartidor_locations (tenant_id)`);

                await client.query(`
                    CREATE TABLE IF NOT EXISTS gps_consent_log (
                        id SERIAL PRIMARY KEY,
                        tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
                        employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
                        consented BOOLEAN NOT NULL DEFAULT false,
                        consented_at TIMESTAMPTZ,
                        revoked_at TIMESTAMPTZ,
                        device_info TEXT,
                        ip_address INET,
                        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    )
                `);
                await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_gps_consent_tenant_employee ON gps_consent_log (tenant_id, employee_id)`);
                console.log('[Schema] ✅ GPS tracking tables ready');
            } catch (gpsErr) {
                console.error(`[Schema] ⚠️ GPS tracking migration error: ${gpsErr.message}`);
            }

            // Patch: Add device_id to repartidor_locations for multi-device security (029)
            try {
                await client.query(`ALTER TABLE repartidor_locations ADD COLUMN IF NOT EXISTS device_id VARCHAR(255)`);
                await client.query(`CREATE INDEX IF NOT EXISTS idx_repartidor_locations_device ON repartidor_locations (employee_id, device_id)`);
                console.log('[Schema] ✅ GPS device_id column ready');
            } catch (deviceErr) {
                console.error(`[Schema] ⚠️ GPS device_id migration error: ${deviceErr.message}`);
            }

            // Patch: Add scale_status columns to branches for persistence across server restarts
            try {
                await client.query(`
                    ALTER TABLE branches
                    ADD COLUMN IF NOT EXISTS scale_status VARCHAR(20) DEFAULT 'unknown',
                    ADD COLUMN IF NOT EXISTS scale_status_updated_at TIMESTAMPTZ
                `);
                console.log('[Schema] ✅ branches.scale_status columns ready');
            } catch (scaleStatusErr) {
                console.error(`[Schema] ⚠️ scale_status migration error: ${scaleStatusErr.message}`);
            }

            // Patch: Add mobile_permissions JSONB column to employees for granular admin permissions
            try {
                await client.query(`
                    ALTER TABLE employees
                    ADD COLUMN IF NOT EXISTS mobile_permissions JSONB DEFAULT NULL
                `);
                // One-time: give existing admin employees the default permission (distributor_mode)
                // Safe to re-run: only affects rows with NULL (never configured by owner)
                await client.query(`
                    UPDATE employees e
                    SET mobile_permissions = '["admin.distributor_mode"]'::jsonb
                    FROM roles r
                    WHERE e.role_id = r.id AND e.tenant_id = r.tenant_id
                      AND r.mobile_access_type = 'admin'
                      AND e.mobile_permissions IS NULL
                      AND e.is_active = true
                `);
                console.log('[Schema] ✅ employees.mobile_permissions column ready');
            } catch (mobilePermErr) {
                console.error(`[Schema] ⚠️ mobile_permissions migration error: ${mobilePermErr.message}`);
            }

            // Patch: Backfill employees.mobile_access_type from roles (per-employee override)
            // Safe to re-run: only affects employees with NULL or 'none' where role has access
            try {
                const backfillResult = await client.query(`
                    UPDATE employees e
                    SET mobile_access_type = r.mobile_access_type
                    FROM roles r
                    WHERE e.role_id = r.id AND e.tenant_id = r.tenant_id
                      AND e.can_use_mobile_app = true
                      AND (e.mobile_access_type IS NULL OR e.mobile_access_type = 'none')
                      AND r.mobile_access_type != 'none'
                `);
                if (backfillResult.rowCount > 0) {
                    console.log(`[Schema] ✅ Backfilled ${backfillResult.rowCount} employees with mobile_access_type from roles`);
                }
            } catch (backfillErr) {
                console.error(`[Schema] ⚠️ mobile_access_type backfill error: ${backfillErr.message}`);
            }

            // Patch: Add data_reset_at to branches (soft reset for per-branch data wipe)
            try {
                await client.query(`ALTER TABLE branches ADD COLUMN IF NOT EXISTS data_reset_at TIMESTAMPTZ NULL`);
                console.log('[Schema] ✅ branches.data_reset_at column ready');
            } catch (resetColErr) {
                console.error(`[Schema] ⚠️ data_reset_at migration error: ${resetColErr.message}`);
            }

            // Patch: Create data_resets audit log table
            try {
                await client.query(`
                    CREATE TABLE IF NOT EXISTS data_resets (
                        id SERIAL PRIMARY KEY,
                        tenant_id INTEGER NOT NULL REFERENCES tenants(id),
                        branch_id INTEGER REFERENCES branches(id),
                        reset_scope VARCHAR(20) NOT NULL DEFAULT 'branch',
                        reset_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        purge_after TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days'),
                        purged_at TIMESTAMPTZ NULL,
                        requested_by_employee_id INTEGER NULL,
                        requested_from VARCHAR(50) DEFAULT 'desktop',
                        records_purged JSONB NULL,
                        created_at TIMESTAMPTZ DEFAULT NOW()
                    )
                `);
                console.log('[Schema] ✅ data_resets audit table ready');
            } catch (resetTableErr) {
                console.error(`[Schema] ⚠️ data_resets table error: ${resetTableErr.message}`);
            }

            // Patch: Backfill employee_branches from employees.main_branch_id
            try {
                const backfillResult = await client.query(`
                    INSERT INTO employee_branches (tenant_id, employee_id, branch_id, created_at, updated_at)
                    SELECT e.tenant_id, e.id, e.main_branch_id, NOW(), NOW()
                    FROM employees e
                    WHERE e.main_branch_id IS NOT NULL
                      AND e.is_active = true
                      AND NOT EXISTS (
                          SELECT 1 FROM employee_branches eb
                          WHERE eb.employee_id = e.id AND eb.branch_id = e.main_branch_id
                      )
                `);
                if (backfillResult.rowCount > 0) {
                    console.log(`[Schema] ✅ employee_branches backfilled: ${backfillResult.rowCount} missing records inserted`);
                }
            } catch (ebErr) {
                console.error(`[Schema] ⚠️ employee_branches backfill error: ${ebErr.message}`);
            }

            // Patch: Create followup_emails table for tracking sent followup emails
            try {
                await client.query(`
                    CREATE TABLE IF NOT EXISTS followup_emails (
                        id SERIAL PRIMARY KEY,
                        tenant_id INTEGER NOT NULL REFERENCES tenants(id),
                        sent_to VARCHAR(255) NOT NULL,
                        subject TEXT NOT NULL,
                        scenario VARCHAR(50),
                        sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    )
                `);
                await client.query(`
                    CREATE INDEX IF NOT EXISTS idx_followup_emails_tenant ON followup_emails(tenant_id)
                `);
                await client.query(`
                    CREATE INDEX IF NOT EXISTS idx_followup_emails_sent_at ON followup_emails(sent_at DESC)
                `);
                console.log('[Schema] ✅ followup_emails table ready');
            } catch (followupErr) {
                console.error(`[Schema] ⚠️ followup_emails table error: ${followupErr.message}`);
            }

            // ── Patch: Add location fields to customers ──
            try {
                await client.query(`
                    ALTER TABLE customers
                        ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION,
                        ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION,
                        ADD COLUMN IF NOT EXISTS google_maps_url TEXT
                `);
                console.log('[Schema] ✅ customers location columns ready');
            } catch (locErr) {
                console.error(`[Schema] ⚠️ customers location columns error: ${locErr.message}`);
            }

            // ── Patch: Add logo_url to branches ──
            try {
                await client.query(`
                    ALTER TABLE branches
                        ADD COLUMN IF NOT EXISTS logo_url TEXT
                `);
                console.log('[Schema] ✅ branches.logo_url column ready');
            } catch (logoErr) {
                console.error(`[Schema] ⚠️ branches.logo_url error: ${logoErr.message}`);
            }

            // ── Patch: Add location fields to branches ──
            try {
                await client.query(`
                    ALTER TABLE branches
                        ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION,
                        ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION,
                        ADD COLUMN IF NOT EXISTS google_maps_url TEXT
                `);
                console.log('[Schema] ✅ branches location columns ready');
            } catch (brLocErr) {
                console.error(`[Schema] ⚠️ branches location columns error: ${brLocErr.message}`);
            }

            // ── Patch: Add session revocation columns for mutual exclusion ──
            try {
                const checkSessionRevoked = await client.query(`
                    SELECT column_name FROM information_schema.columns
                    WHERE table_name = 'employees' AND column_name = 'session_revoked_at'
                `);
                if (checkSessionRevoked.rows.length === 0) {
                    console.log('[Schema] 📝 Adding session revocation columns to employees...');
                    await client.query(`
                        ALTER TABLE employees
                        ADD COLUMN session_revoked_at TIMESTAMPTZ DEFAULT NULL
                    `);
                    await client.query(`
                        ALTER TABLE employees
                        ADD COLUMN session_revoked_for_device VARCHAR(20) DEFAULT NULL
                    `);
                    console.log('[Schema] ✅ Session revocation columns added');
                }
            } catch (err) {
                console.error('[Schema] ⚠️ Error adding session revocation columns:', err.message);
            }

            // ── Patch: Add multi-caja support columns (migration 037) ──
            try {
                await client.query(`
                    ALTER TABLE branches
                    ADD COLUMN IF NOT EXISTS multi_caja_enabled BOOLEAN DEFAULT false
                `);
                await client.query(`
                    ALTER TABLE shifts
                    ADD COLUMN IF NOT EXISTS last_heartbeat TIMESTAMPTZ
                `);
                await client.query(`
                    CREATE INDEX IF NOT EXISTS idx_shifts_active_heartbeat
                    ON shifts(employee_id, is_cash_cut_open)
                    WHERE is_cash_cut_open = true
                `);
                console.log('[Schema] ✅ Multi-caja columns ready');
            } catch (mcErr) {
                console.error(`[Schema] ⚠️ Multi-caja columns error: ${mcErr.message}`);
            }

            // ── Patch: Create customer_product_prices table (migration 039) ──
            try {
                const checkCppTable = await client.query(`
                    SELECT EXISTS (
                        SELECT FROM information_schema.tables
                        WHERE table_name = 'customer_product_prices'
                    )
                `);
                if (!checkCppTable.rows[0].exists) {
                    console.log('[Schema] 📝 Creating customer_product_prices table...');
                    const fs = require('fs');
                    const path = require('path');
                    const migrationPath = path.join(__dirname, '..', 'migrations', '039_customer_product_prices.sql');
                    if (fs.existsSync(migrationPath)) {
                        const sql = fs.readFileSync(migrationPath, 'utf8');
                        await client.query(sql);
                        console.log('[Schema] ✅ customer_product_prices table created');
                    } else {
                        console.log('[Schema] ⚠️ Migration file 039 not found, creating inline...');
                        await client.query(`
                            CREATE TABLE IF NOT EXISTS customer_product_prices (
                                id SERIAL PRIMARY KEY,
                                tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
                                customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
                                product_id INTEGER NOT NULL REFERENCES productos(id) ON DELETE CASCADE,
                                special_price NUMERIC(10,2),
                                discount_percentage NUMERIC(5,2) DEFAULT 0,
                                set_by_employee_id INTEGER,
                                set_at TIMESTAMPTZ DEFAULT NOW(),
                                notes TEXT,
                                global_id VARCHAR(255) UNIQUE NOT NULL,
                                terminal_id VARCHAR(255),
                                local_op_seq INTEGER,
                                created_local_utc TEXT,
                                device_event_raw BIGINT,
                                is_active BOOLEAN DEFAULT TRUE,
                                created_at TIMESTAMPTZ DEFAULT NOW(),
                                updated_at TIMESTAMPTZ DEFAULT NOW(),
                                UNIQUE(tenant_id, customer_id, product_id)
                            )
                        `);
                        await client.query(`CREATE INDEX IF NOT EXISTS idx_cpp_tenant_customer ON customer_product_prices(tenant_id, customer_id) WHERE is_active = TRUE`);
                        await client.query(`CREATE INDEX IF NOT EXISTS idx_cpp_global_id ON customer_product_prices(global_id)`);
                        await client.query(`CREATE INDEX IF NOT EXISTS idx_cpp_lookup ON customer_product_prices(tenant_id, customer_id, product_id) WHERE is_active = TRUE`);
                        await client.query(`CREATE INDEX IF NOT EXISTS idx_cpp_updated ON customer_product_prices(updated_at)`);
                        console.log('[Schema] ✅ customer_product_prices table created (inline)');
                    }
                }
            } catch (cppErr) {
                console.error(`[Schema] ⚠️ customer_product_prices error: ${cppErr.message}`);
            }

            // ── Patch: Create producto_branches table (migration 040) ──
            try {
                const checkPbTable = await client.query(`
                    SELECT EXISTS (
                        SELECT FROM information_schema.tables
                        WHERE table_name = 'producto_branches'
                    )
                `);
                if (!checkPbTable.rows[0].exists) {
                    console.log('[Schema] 📝 Creating producto_branches table...');
                    await client.query(`
                        CREATE TABLE IF NOT EXISTS producto_branches (
                            id SERIAL PRIMARY KEY,
                            tenant_id INTEGER NOT NULL REFERENCES tenants(id),
                            branch_id INTEGER NOT NULL REFERENCES branches(id),
                            product_global_id UUID NOT NULL,
                            precio_venta DOUBLE PRECISION NOT NULL DEFAULT 0,
                            precio_compra DOUBLE PRECISION NOT NULL DEFAULT 0,
                            inventario DOUBLE PRECISION NOT NULL DEFAULT 0,
                            minimo DOUBLE PRECISION NOT NULL DEFAULT 0,
                            is_active BOOLEAN NOT NULL DEFAULT true,
                            assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                            global_id UUID NOT NULL UNIQUE,
                            terminal_id TEXT,
                            local_op_seq BIGINT,
                            created_local_utc TEXT,
                            device_event_raw BIGINT,
                            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                            UNIQUE(tenant_id, product_global_id, branch_id)
                        )
                    `);
                    await client.query(`CREATE INDEX IF NOT EXISTS idx_producto_branches_tenant_branch ON producto_branches(tenant_id, branch_id)`);
                    await client.query(`CREATE INDEX IF NOT EXISTS idx_producto_branches_global_id ON producto_branches(global_id)`);
                    console.log('[Schema] ✅ producto_branches table created');
                }
            } catch (pbErr) {
                console.error(`[Schema] ⚠️ producto_branches error: ${pbErr.message}`);
            }

            // ── Patch: Add branch_id to precios_especiales_cliente (migration 040b) ──
            try {
                const checkPecBranchId = await client.query(`
                    SELECT column_name
                    FROM information_schema.columns
                    WHERE table_name = 'customer_product_prices'
                    AND column_name = 'branch_id'
                `);
                if (checkPecBranchId.rows.length === 0) {
                    console.log('[Schema] 📝 Adding branch_id to customer_product_prices...');
                    await client.query(`
                        ALTER TABLE customer_product_prices
                        ADD COLUMN IF NOT EXISTS branch_id INTEGER DEFAULT 0
                    `);
                    console.log('[Schema] ✅ customer_product_prices.branch_id added');
                }
            } catch (pecErr) {
                console.error(`[Schema] ⚠️ customer_product_prices.branch_id error: ${pecErr.message}`);
            }

            // ── Migration 041: branch_settings table (JSONB per-branch config) ──
            try {
                const checkBranchSettings = await client.query(`
                    SELECT to_regclass('public.branch_settings') as exists
                `);
                if (!checkBranchSettings.rows[0].exists) {
                    console.log('[Schema] 📝 Creating branch_settings table...');
                    await client.query(`
                        CREATE TABLE branch_settings (
                            id SERIAL PRIMARY KEY,
                            tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
                            branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
                            setting_key VARCHAR(100) NOT NULL,
                            setting_value JSONB NOT NULL DEFAULT '{}',
                            updated_at TIMESTAMPTZ DEFAULT NOW(),
                            updated_by_terminal_id VARCHAR(36),
                            UNIQUE(tenant_id, branch_id, setting_key)
                        )
                    `);
                    await client.query(`CREATE INDEX IF NOT EXISTS idx_branch_settings_tenant_branch ON branch_settings(tenant_id, branch_id)`);
                    console.log('[Schema] ✅ branch_settings table created');
                }
            } catch (bsErr) {
                console.error(`[Schema] ⚠️ branch_settings error: ${bsErr.message}`);
            }

            // ── Patch: Add is_practice flag to notifications (Practice Mode) ──
            try {
                const checkIsPractice = await client.query(`
                    SELECT column_name
                    FROM information_schema.columns
                    WHERE table_name = 'notifications'
                    AND column_name = 'is_practice'
                `);
                if (checkIsPractice.rows.length === 0) {
                    console.log('[Schema] 📝 Adding is_practice column to notifications...');
                    await client.query(`
                        ALTER TABLE notifications ADD COLUMN IF NOT EXISTS is_practice BOOLEAN DEFAULT FALSE
                    `);
                    await client.query(`
                        CREATE INDEX IF NOT EXISTS idx_notifications_practice ON notifications(is_practice) WHERE is_practice = true
                    `);
                    console.log('[Schema] ✅ notifications.is_practice added');
                }
            } catch (ipErr) {
                console.error(`[Schema] ⚠️ notifications.is_practice error: ${ipErr.message}`);
            }

            // ═══════════════════════════════════════════════════════════
            // sync_error_reports — Reportes de errores de sincronización enviados desde Desktop
            // ═══════════════════════════════════════════════════════════
            try {
                await client.query(`
                    CREATE TABLE IF NOT EXISTS sync_error_reports (
                        id SERIAL PRIMARY KEY,
                        tenant_id INTEGER NOT NULL REFERENCES tenants(id),
                        branch_id INTEGER NOT NULL REFERENCES branches(id),
                        device_id TEXT NOT NULL,
                        device_name TEXT,
                        app_version TEXT,
                        auto_generated BOOLEAN DEFAULT FALSE,
                        sync_stats JSONB,
                        errors JSONB,
                        created_at TIMESTAMPTZ DEFAULT NOW()
                    )
                `);
                await client.query(`CREATE INDEX IF NOT EXISTS idx_sync_reports_tenant ON sync_error_reports(tenant_id)`);
                await client.query(`CREATE INDEX IF NOT EXISTS idx_sync_reports_branch ON sync_error_reports(tenant_id, branch_id)`);
                await client.query(`CREATE INDEX IF NOT EXISTS idx_sync_reports_created ON sync_error_reports(created_at)`);
                console.log('[Schema] ✅ sync_error_reports table ensured');
            } catch (serErr) {
                console.error(`[Schema] ⚠️ sync_error_reports error: ${serErr.message}`);
            }

            // ═══════════════════════════════════════════════════════════
            // Patch: Add tenant_id to global_expense_categories for custom categories
            // ═══════════════════════════════════════════════════════════
            try {
                const checkTenantIdCol = await client.query(`
                    SELECT column_name
                    FROM information_schema.columns
                    WHERE table_name = 'global_expense_categories'
                    AND column_name = 'tenant_id'
                `);

                if (checkTenantIdCol.rows.length === 0) {
                    console.log('[Schema] 📝 Adding global_expense_categories.tenant_id column...');

                    // Add nullable tenant_id column (NULL = canonical/global, non-NULL = tenant-specific)
                    await client.query(`
                        ALTER TABLE global_expense_categories
                        ADD COLUMN tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE
                    `);

                    // Change id column to use a sequence for auto-increment on new rows
                    // First create the sequence starting after the canonical IDs
                    await client.query(`
                        CREATE SEQUENCE IF NOT EXISTS global_expense_categories_id_seq
                        START WITH 100 OWNED BY global_expense_categories.id
                    `);
                    await client.query(`
                        ALTER TABLE global_expense_categories
                        ALTER COLUMN id SET DEFAULT nextval('global_expense_categories_id_seq')
                    `);

                    // Drop the old UNIQUE constraint on name and replace with a partial unique index
                    // This allows same name across tenants but not within same tenant/global scope
                    await client.query(`
                        ALTER TABLE global_expense_categories
                        DROP CONSTRAINT IF EXISTS global_expense_categories_name_key
                    `);
                    await client.query(`
                        CREATE UNIQUE INDEX IF NOT EXISTS idx_expense_categories_name_global
                        ON global_expense_categories (LOWER(name))
                        WHERE tenant_id IS NULL
                    `);
                    await client.query(`
                        CREATE UNIQUE INDEX IF NOT EXISTS idx_expense_categories_name_tenant
                        ON global_expense_categories (LOWER(name), tenant_id)
                        WHERE tenant_id IS NOT NULL
                    `);

                    // Index for filtering by tenant
                    await client.query(`
                        CREATE INDEX IF NOT EXISTS idx_expense_categories_tenant
                        ON global_expense_categories (tenant_id)
                    `);

                    console.log('[Schema] ✅ global_expense_categories.tenant_id column and indexes added');
                }
            } catch (tenantCatErr) {
                console.error(`[Schema] ⚠️ global_expense_categories tenant_id migration error: ${tenantCatErr.message}`);
            }

            // ── Migration 042: Add Cajero role to existing tenants ──
            try {
                const tenantsWithoutCajero = await client.query(`
                    SELECT t.id FROM tenants t
                    WHERE NOT EXISTS (
                        SELECT 1 FROM roles r WHERE r.tenant_id = t.id AND r.name = 'Cajero'
                    )
                `);
                if (tenantsWithoutCajero.rows.length > 0) {
                    console.log(`[Schema] 📝 Adding Cajero role to ${tenantsWithoutCajero.rows.length} tenants (Migration 042)...`);
                    for (const row of tenantsWithoutCajero.rows) {
                        await client.query(`
                            INSERT INTO roles (tenant_id, name, description, is_system, mobile_access_type)
                            VALUES ($1, 'Cajero', 'Ventas, liquidaciones y producción', true, 'cashier')
                            ON CONFLICT DO NOTHING
                        `, [row.id]);

                        // Assign Cajero permissions
                        await client.query(`
                            INSERT INTO role_permissions (role_id, permission_id)
                            SELECT r.id, p.id
                            FROM roles r CROSS JOIN permissions p
                            WHERE r.tenant_id = $1 AND r.name = 'Cajero'
                            AND p.code IN ('AccessPointOfSale', 'SettleDeliveries', 'ManageExpenses', 'AccessProduction')
                            ON CONFLICT DO NOTHING
                        `, [row.id]);
                    }
                    console.log(`[Schema] ✅ Cajero role added to ${tenantsWithoutCajero.rows.length} tenants`);
                }
            } catch (cajeroErr) {
                console.error(`[Schema] ⚠️ Cajero role migration error: ${cajeroErr.message}`);
            }

            // ── Migration: Make telemetry_events.branch_id nullable ──
            // After Apple re-auth, app_open fires before branch is selected
            try {
                const checkTelemetryBranch = await client.query(`
                    SELECT is_nullable
                    FROM information_schema.columns
                    WHERE table_name = 'telemetry_events'
                    AND column_name = 'branch_id'
                `);
                if (checkTelemetryBranch.rows.length > 0 && checkTelemetryBranch.rows[0].is_nullable === 'NO') {
                    console.log('[Schema] 📝 Making telemetry_events.branch_id nullable...');
                    await client.query(`ALTER TABLE telemetry_events ALTER COLUMN branch_id DROP NOT NULL`);
                    console.log('[Schema] ✅ telemetry_events.branch_id is now nullable');
                }
            } catch (telErr) {
                console.error(`[Schema] ⚠️ telemetry branch_id nullable error: ${telErr.message}`);
            }

            // ── Migration: Deduplicate categorias_productos by tenant+nombre ──
            // Desktop and Flutter each create system categories with random global_ids,
            // causing duplicates. Soft-delete duplicates (keep oldest per tenant+nombre)
            // so Desktop RemoteId mappings aren't broken.
            try {
                const dupCheck = await client.query(`
                    SELECT tenant_id, nombre, COUNT(*) as cnt
                    FROM categorias_productos
                    WHERE is_deleted = false
                    GROUP BY tenant_id, nombre
                    HAVING COUNT(*) > 1
                `);
                if (dupCheck.rows.length > 0) {
                    console.log(`[Schema] 📝 Found ${dupCheck.rows.length} duplicated category names, soft-deleting extras...`);
                    const softDeleteResult = await client.query(`
                        UPDATE categorias_productos
                        SET is_deleted = true, is_available = false, deleted_at = NOW(), updated_at = NOW()
                        WHERE id IN (
                            SELECT id FROM (
                                SELECT id,
                                    ROW_NUMBER() OVER (PARTITION BY tenant_id, nombre ORDER BY created_at ASC, id ASC) as rn
                                FROM categorias_productos
                                WHERE is_deleted = false
                            ) ranked
                            WHERE rn > 1
                        )
                    `);
                    console.log(`[Schema] ✅ Soft-deleted ${softDeleteResult.rowCount} duplicate categories`);
                }
            } catch (dedupErr) {
                console.error(`[Schema] ⚠️ Category dedup error: ${dedupErr.message}`);
            }

            // ── Migration 044: Add missing columns to expenses table for mobile sync ──
            // The POST /api/expenses/sync endpoint references columns that don't exist yet
            try {
                const missingCols = [
                    { name: 'consumer_employee_id', sql: 'INTEGER REFERENCES employees(id) ON DELETE SET NULL' },
                    { name: 'payment_type_id', sql: 'INTEGER DEFAULT 1' },
                    { name: 'id_turno', sql: 'INTEGER' },
                    { name: 'quantity', sql: 'DECIMAL(10,3)' },
                    { name: 'status', sql: "VARCHAR(50) DEFAULT 'confirmed'" },
                    { name: 'reviewed_by_desktop', sql: 'BOOLEAN DEFAULT false' },
                    { name: 'is_active', sql: 'BOOLEAN DEFAULT true' },
                    { name: 'global_id', sql: 'VARCHAR(255)' },
                    { name: 'terminal_id', sql: 'VARCHAR(100)' },
                    { name: 'local_op_seq', sql: 'BIGINT DEFAULT 0' },
                    { name: 'created_local_utc', sql: 'TEXT' },
                    { name: 'device_event_raw', sql: 'BIGINT' },
                ];

                let addedCount = 0;
                for (const col of missingCols) {
                    const check = await client.query(`
                        SELECT column_name FROM information_schema.columns
                        WHERE table_name = 'expenses' AND column_name = $1
                    `, [col.name]);
                    if (check.rows.length === 0) {
                        await client.query(`ALTER TABLE expenses ADD COLUMN ${col.name} ${col.sql}`);
                        addedCount++;
                    }
                }

                if (addedCount > 0) {
                    // Add unique index on global_id for idempotency
                    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_expenses_global_id ON expenses(global_id) WHERE global_id IS NOT NULL`);
                    await client.query(`CREATE INDEX IF NOT EXISTS idx_expenses_status ON expenses(status)`);
                    await client.query(`CREATE INDEX IF NOT EXISTS idx_expenses_is_active ON expenses(is_active) WHERE is_active = true`);
                    console.log(`[Schema] ✅ Added ${addedCount} missing columns to expenses table (Migration 044)`);
                }
            } catch (expColErr) {
                console.error(`[Schema] ⚠️ Expenses columns migration error: ${expColErr.message}`);
            }

            // ── Migration 043: Disable duplicate "Otros" expense category (ID 14) ──
            // "Otros Gastos" (ID 12) already covers this. ID 14 is redundant.
            try {
                await client.query(`
                    UPDATE global_expense_categories
                    SET is_available = false
                    WHERE id = 14 AND name = 'Otros' AND is_available = true
                `);
            } catch (otrosErr) {
                console.error(`[Schema] ⚠️ Otros category disable error: ${otrosErr.message}`);
            }

            // ── Migration 045: Create kardex_entries table ──
            try {
                const kardexCheck = await client.query(`
                    SELECT EXISTS (
                        SELECT FROM information_schema.tables
                        WHERE table_name = 'kardex_entries'
                    );
                `);
                if (!kardexCheck.rows[0].exists) {
                    await client.query(`
                        CREATE TABLE kardex_entries (
                            id SERIAL PRIMARY KEY,
                            tenant_id INTEGER NOT NULL REFERENCES tenants(id),
                            branch_id INTEGER REFERENCES branches(id),
                            product_id INTEGER REFERENCES productos(id),
                            product_global_id VARCHAR(36),
                            timestamp TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
                            movement_type VARCHAR(50) NOT NULL,
                            employee_id INTEGER REFERENCES employees(id),
                            employee_global_id VARCHAR(36),
                            quantity_before NUMERIC(10,2) DEFAULT 0,
                            quantity_change NUMERIC(10,2) DEFAULT 0,
                            quantity_after NUMERIC(10,2) DEFAULT 0,
                            description TEXT DEFAULT '',
                            sale_id INTEGER,
                            purchase_id INTEGER,
                            adjustment_id INTEGER,
                            global_id VARCHAR(36) NOT NULL UNIQUE,
                            terminal_id VARCHAR(100),
                            source VARCHAR(20) DEFAULT 'desktop',
                            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                            updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
                        );
                        CREATE INDEX idx_kardex_tenant ON kardex_entries(tenant_id);
                        CREATE INDEX idx_kardex_product ON kardex_entries(product_id);
                        CREATE INDEX idx_kardex_branch ON kardex_entries(branch_id);
                        CREATE INDEX idx_kardex_timestamp ON kardex_entries(timestamp);
                        CREATE INDEX idx_kardex_global_id ON kardex_entries(global_id);
                    `);
                    console.log('[Schema] ✅ Created kardex_entries table (Migration 045)');
                }
            } catch (kardexErr) {
                console.error(`[Schema] ⚠️ kardex_entries migration error: ${kardexErr.message}`);
            }

            // ── Migration 046: Fix producto_branches UUID columns → TEXT ──
            // productos.global_id is VARCHAR(255) but producto_branches.product_global_id was UUID,
            // causing failures with legacy seed global_ids like "SEED_PRODUCT_63_9001"
            try {
                await client.query(`ALTER TABLE producto_branches ALTER COLUMN product_global_id TYPE TEXT`);
                await client.query(`ALTER TABLE producto_branches ALTER COLUMN global_id TYPE TEXT`);
                console.log('[Schema] ✅ producto_branches UUID columns changed to TEXT (Migration 046)');
            } catch (m046err) {
                // Already TEXT or doesn't exist — safe to ignore
                console.log('[Schema] ⚠️ Migration 046:', m046err.message);
            }

            // ── Migration 047: Ensure employee_branches unique constraint exists ──
            try {
                await client.query(`
                    ALTER TABLE employee_branches
                    DROP CONSTRAINT IF EXISTS employee_branches_employee_id_branch_id_key
                `);
                await client.query(`
                    ALTER TABLE employee_branches
                    ADD CONSTRAINT employee_branches_employee_id_branch_id_key
                    UNIQUE (employee_id, branch_id)
                `);
                console.log('[Schema] ✅ employee_branches unique constraint ensured (Migration 047)');
            } catch (m047err) {
                console.log('[Schema] ⚠️ Migration 047:', m047err.message);
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

module.exports = { runMigrations };
