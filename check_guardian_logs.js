const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function checkGuardianLogs() {
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║   🔍 CHECKING GUARDIAN LOGS IN POSTGRESQL               ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    try {
        // Check if table exists
        const tableCheck = await pool.query(`
            SELECT EXISTS (
                SELECT FROM information_schema.tables
                WHERE table_name = 'suspicious_weighing_logs'
            );
        `);

        if (!tableCheck.rows[0].exists) {
            console.log('❌ Table suspicious_weighing_logs does not exist');
            await pool.end();
            process.exit(1);
        }

        console.log('✅ Table suspicious_weighing_logs exists\n');

        // Get recent logs
        const logs = await pool.query(`
            SELECT
                id,
                global_id,
                event_type,
                weight_detected,
                severity,
                shift_id,
                employee_id,
                terminal_id,
                local_op_seq,
                created_at,
                updated_at
            FROM suspicious_weighing_logs
            ORDER BY created_at DESC
            LIMIT 5
        `);

        console.log(`📊 Found ${logs.rows.length} Guardian logs:\n`);

        logs.rows.forEach((log, index) => {
            console.log(`${index + 1}. Guardian Log ID=${log.id}`);
            console.log(`   GlobalId: ${log.global_id}`);
            console.log(`   Event: ${log.event_type}`);
            console.log(`   Weight: ${log.weight_detected}kg`);
            console.log(`   Severity: ${log.severity}`);
            console.log(`   ShiftId: ${log.shift_id}`);
            console.log(`   EmployeeId: ${log.employee_id}`);
            console.log(`   TerminalId: ${log.terminal_id}`);
            console.log(`   LocalOpSeq: ${log.local_op_seq}`);
            console.log(`   Created: ${log.created_at}`);
            console.log(`   Updated: ${log.updated_at}`);
            console.log('');
        });

        // Check for the most recent log with the GlobalId from the user's output
        const specificLog = await pool.query(`
            SELECT * FROM suspicious_weighing_logs
            WHERE global_id = 'd78ca909-f018-408c-a544-297dd22f0f36'
        `);

        if (specificLog.rows.length > 0) {
            console.log('✅ FOUND THE LOG FROM THE TEST:');
            console.log(`   ID: ${specificLog.rows[0].id}`);
            console.log(`   GlobalId: ${specificLog.rows[0].global_id}`);
            console.log(`   EventType: ${specificLog.rows[0].event_type}`);
            console.log(`   Weight: ${specificLog.rows[0].weight_detected}kg`);
            console.log(`   Synced successfully! 🎉\n`);
        } else {
            console.log('⚠️  The specific log from the test was not found yet.');
            console.log('   It may still be syncing or there may be a sync issue.\n');
        }

        await pool.end();
        process.exit(0);

    } catch (error) {
        console.error('\n❌ Error checking Guardian logs:');
        console.error(error.message);
        console.error('\nStack trace:');
        console.error(error.stack);

        await pool.end();
        process.exit(1);
    }
}

// Ejecutar
checkGuardianLogs();
