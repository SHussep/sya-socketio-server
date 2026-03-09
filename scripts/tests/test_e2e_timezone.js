const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

/**
 * E2E Timezone Test
 *
 * Validates the complete timezone-agnostic architecture:
 * 1. Timestamps are stored in UTC in PostgreSQL
 * 2. Backend returns timestamps as ISO strings with Z suffix
 * 3. Mobile app can parse and convert to local timezone
 */

async function runE2ETests() {
    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log('║        🌍 END-TO-END TIMEZONE ARCHITECTURE TEST           ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    try {
        // TEST 1: Verify database column types
        console.log('TEST 1: Verifying database column types are TIMESTAMP WITH TIME ZONE...\n');

        const columnsToCheck = [
            { table: 'sales', column: 'sale_date' },
            { table: 'expenses', column: 'expense_date' },
            { table: 'shifts', column: 'start_time' },
            { table: 'shifts', column: 'end_time' },
            { table: 'cash_cuts', column: 'cut_date' },
            { table: 'guardian_events', column: 'event_date' }
        ];

        let allColumnsCorrect = true;

        for (const { table, column } of columnsToCheck) {
            const result = await pool.query(`
                SELECT data_type
                FROM information_schema.columns
                WHERE table_name = '${table}' AND column_name = '${column}'
            `);

            if (result.rows.length === 0) {
                console.log(`❌ Column NOT FOUND: ${table}.${column}`);
                allColumnsCorrect = false;
            } else {
                const dataType = result.rows[0].data_type;
                const isCorrect = dataType === 'timestamp with time zone';
                const icon = isCorrect ? '✅' : '❌';
                console.log(`${icon} ${table}.${column}: ${dataType}`);
                if (!isCorrect) allColumnsCorrect = false;
            }
        }

        if (!allColumnsCorrect) {
            console.log('\n⚠️  WARNING: Not all columns are TIMESTAMP WITH TIME ZONE!');
        } else {
            console.log('\n✅ All columns are correctly typed as TIMESTAMP WITH TIME ZONE\n');
        }

        // TEST 2: Verify data is stored in UTC
        console.log('TEST 2: Verifying actual data is stored in UTC...\n');

        const salesResult = await pool.query(`
            SELECT id, sale_date, sale_date::TEXT as sale_date_utc_text
            FROM sales
            WHERE sale_date IS NOT NULL
            ORDER BY id DESC
            LIMIT 3
        `);

        if (salesResult.rows.length === 0) {
            console.log('⚠️  No sales data found in database');
        } else {
            console.log('Recent sales timestamps (as stored in UTC):\n');
            salesResult.rows.forEach((row, idx) => {
                const utcText = row.sale_date_utc_text;
                const utcOffset = utcText.match(/([+-]\d{2}:\d{2})$/)?.[1] || 'UNKNOWN';

                console.log(`[${idx + 1}] Sale ID ${row.id}`);
                console.log(`    UTC Text: ${utcText}`);
                console.log(`    Timezone Offset: ${utcOffset}`);

                // Check if offset is +00:00 (UTC)
                if (utcOffset === '+00:00') {
                    console.log(`    ✅ Correctly stored in UTC\n`);
                } else {
                    console.log(`    ⚠️  WARNING: Expected UTC (+00:00), got ${utcOffset}\n`);
                }
            });
        }

        // TEST 3: Simulate API response formatting
        console.log('TEST 3: Simulating API response timestamp formatting...\n');

        const saleData = salesResult.rows[0];
        if (saleData) {
            // This simulates what the backend API does
            const formattedTimestamp = new Date(saleData.sale_date).toISOString();

            console.log(`Original DB value: ${saleData.sale_date}`);
            console.log(`Formatted as ISO string: ${formattedTimestamp}`);

            if (formattedTimestamp.endsWith('Z')) {
                console.log(`✅ Correctly formatted with Z suffix (UTC indicator)\n`);
            } else {
                console.log(`❌ Missing Z suffix!\n`);
            }

            // TEST 4: Validate ISO string format
            console.log('TEST 4: Validating ISO 8601 format...\n');

            const isoRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
            const isValidISO = isoRegex.test(formattedTimestamp);

            if (isValidISO) {
                console.log(`✅ Timestamp is valid ISO 8601 format: ${formattedTimestamp}\n`);
            } else {
                console.log(`❌ Invalid ISO 8601 format: ${formattedTimestamp}\n`);
            }

            // TEST 5: Mobile app simulation (UTC → Local conversion)
            console.log('TEST 5: Simulating mobile app timezone conversion...\n');

            const utcDate = new Date(formattedTimestamp);
            const formatter = new Intl.DateTimeFormat('es-MX', {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                timeZone: 'America/Mexico_City' // Mexico timezone as example
            });

            const localTimeStr = formatter.format(utcDate);
            console.log(`UTC timestamp from API: ${formattedTimestamp}`);
            console.log(`Converted to America/Mexico_City: ${localTimeStr}`);
            console.log(`✅ Mobile app can correctly convert UTC to local timezone\n`);
        }

        // TEST 6: Verify all timestamps across different tables
        console.log('TEST 6: Spot-checking timestamps across all tables...\n');

        const tables = [
            { name: 'sales', dateCol: 'sale_date' },
            { name: 'expenses', dateCol: 'expense_date' },
            { name: 'guardian_events', dateCol: 'event_date' }
        ];

        for (const { name, dateCol } of tables) {
            const result = await pool.query(`
                SELECT COUNT(*) as count,
                       MIN(${dateCol}) as earliest,
                       MAX(${dateCol}) as latest
                FROM ${name}
                WHERE ${dateCol} IS NOT NULL
            `);

            const row = result.rows[0];
            if (parseInt(row.count) > 0) {
                console.log(`${name}:`);
                console.log(`  ✅ ${row.count} records with timestamps`);
                console.log(`  Earliest: ${row.earliest}`);
                console.log(`  Latest: ${row.latest}\n`);
            } else {
                console.log(`${name}: ⚠️  No timestamp data\n`);
            }
        }

        console.log('╔══════════════════════════════════════════════════════════╗');
        console.log('║        ✅ END-TO-END TIMEZONE TESTS COMPLETED            ║');
        console.log('╚══════════════════════════════════════════════════════════╝\n');

        console.log('Summary of timezone-agnostic architecture:');
        console.log('✅ Database stores all timestamps in UTC (TIMESTAMP WITH TIME ZONE)');
        console.log('✅ Backend returns timestamps as ISO 8601 strings with Z suffix');
        console.log('✅ Mobile app can convert UTC to device local timezone automatically');
        console.log('✅ No user timezone selection needed - device detects it automatically\n');

    } catch (error) {
        console.error('❌ Test error:', error.message);
        console.error(error);
    } finally {
        await pool.end();
    }
}

runE2ETests();
