// ═══════════════════════════════════════════════════════════════
// MIGRATION 022: Convert TIMESTAMP WITH TIME ZONE to TIMESTAMP
// ═══════════════════════════════════════════════════════════════
//
// REASON: PostgreSQL's TIMESTAMP WITH TIME ZONE is causing
// timezone interpretation issues. By using TIMESTAMP (without TZ),
// we store the exact UTC value without any timezone conversion.
// All timestamps are sent as ISO 8601 strings from the server,
// and PostgreSQL will store them exactly as received.

module.exports = {
    name: '022_fix_timestamps_to_timestamp_without_tz',
    async up(client) {
        console.log('🔄 Executing migration 022: Converting TIMESTAMP WITH TIME ZONE to TIMESTAMP...');

        try {
            // Sales table
            await client.query(`
                ALTER TABLE IF EXISTS sales
                ALTER COLUMN sale_date SET DATA TYPE TIMESTAMP USING sale_date AT TIME ZONE 'UTC'
            `);
            console.log('✅ sales.sale_date converted');

            // Expenses table
            await client.query(`
                ALTER TABLE IF EXISTS expenses
                ALTER COLUMN expense_date SET DATA TYPE TIMESTAMP USING expense_date AT TIME ZONE 'UTC'
            `);
            console.log('✅ expenses.expense_date converted');

            // Purchases table
            await client.query(`
                ALTER TABLE IF EXISTS purchases
                ALTER COLUMN purchase_date SET DATA TYPE TIMESTAMP USING purchase_date AT TIME ZONE 'UTC'
            `);
            console.log('✅ purchases.purchase_date converted');

            // Cash cuts
            await client.query(`
                ALTER TABLE IF EXISTS cash_cuts
                ALTER COLUMN cut_date SET DATA TYPE TIMESTAMP USING cut_date AT TIME ZONE 'UTC'
            `);
            console.log('✅ cash_cuts.cut_date converted');

            // Guardian events
            await client.query(`
                ALTER TABLE IF EXISTS guardian_events
                ALTER COLUMN event_date SET DATA TYPE TIMESTAMP USING event_date AT TIME ZONE 'UTC'
            `);
            console.log('✅ guardian_events.event_date converted');

            // Shifts
            await client.query(`
                ALTER TABLE IF EXISTS shifts
                ALTER COLUMN start_time SET DATA TYPE TIMESTAMP USING start_time AT TIME ZONE 'UTC'
            `);
            console.log('✅ shifts.start_time converted');

            await client.query(`
                ALTER TABLE IF EXISTS shifts
                ALTER COLUMN end_time SET DATA TYPE TIMESTAMP USING end_time AT TIME ZONE 'UTC'
            `);
            console.log('✅ shifts.end_time converted');

            // Cash drawer sessions
            await client.query(`
                ALTER TABLE IF EXISTS cash_drawer_sessions
                ALTER COLUMN start_time SET DATA TYPE TIMESTAMP USING start_time AT TIME ZONE 'UTC'
            `);
            console.log('✅ cash_drawer_sessions.start_time converted');

            await client.query(`
                ALTER TABLE IF EXISTS cash_drawer_sessions
                ALTER COLUMN close_time SET DATA TYPE TIMESTAMP USING close_time AT TIME ZONE 'UTC'
            `);
            console.log('✅ cash_drawer_sessions.close_time converted');

            await client.query(`
                ALTER TABLE IF EXISTS cash_drawer_sessions
                ALTER COLUMN opened_at SET DATA TYPE TIMESTAMP USING opened_at AT TIME ZONE 'UTC'
            `);
            console.log('✅ cash_drawer_sessions.opened_at converted');

            await client.query(`
                ALTER TABLE IF EXISTS cash_drawer_sessions
                ALTER COLUMN closed_at SET DATA TYPE TIMESTAMP USING closed_at AT TIME ZONE 'UTC'
            `);
            console.log('✅ cash_drawer_sessions.closed_at converted');

            // Cash transactions
            await client.query(`
                ALTER TABLE IF EXISTS cash_transactions
                ALTER COLUMN transaction_timestamp SET DATA TYPE TIMESTAMP USING transaction_timestamp AT TIME ZONE 'UTC'
            `);
            console.log('✅ cash_transactions.transaction_timestamp converted');

            await client.query(`
                ALTER TABLE IF EXISTS cash_transactions
                ALTER COLUMN voided_at SET DATA TYPE TIMESTAMP USING voided_at AT TIME ZONE 'UTC'
            `);
            console.log('✅ cash_transactions.voided_at converted');

            console.log('✅ Migración 022 completada: Todos los timestamps convertidos a TIMESTAMP (sin zona horaria)');
        } catch (error) {
            console.error('❌ Error in migration 022:', error.message);
            throw error;
        }
    }
};
