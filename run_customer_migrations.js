const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function runMigrations() {
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║   🚀 CUSTOMER SYNC MIGRATIONS - SYA TORTILLERÍAS        ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    const migrations = [
        '071_create_generic_customer_per_tenant.sql',
        '072_add_offline_first_to_customers.sql'
    ];

    try {
        for (const migrationFile of migrations) {
            const migrationPath = path.join(__dirname, 'migrations', migrationFile);
            console.log(`📂 Running migration: ${migrationFile}`);

            if (!fs.existsSync(migrationPath)) {
                console.log(`⚠️  Migration file not found: ${migrationPath}`);
                continue;
            }

            const sql = fs.readFileSync(migrationPath, 'utf8');

            try {
                await pool.query(sql);
                console.log(`✅ ${migrationFile} executed successfully\n`);
            } catch (error) {
                console.error(`❌ Error running ${migrationFile}:`, error.message);
                console.error(`   Details:`, error);
                // Continue with next migration even if this one fails
            }
        }

        // Verify function exists
        console.log('\n🔍 Verifying get_or_create_generic_customer function...');
        const funcCheck = await pool.query(`
            SELECT proname, pronargs
            FROM pg_proc
            WHERE proname = 'get_or_create_generic_customer'
        `);

        if (funcCheck.rows.length > 0) {
            console.log(`✅ Function exists with ${funcCheck.rows[0].pronargs} arguments`);
        } else {
            console.log(`❌ Function NOT found`);
        }

        // Check customers table structure
        console.log('\n🔍 Checking customers table structure...');
        const columnsCheck = await pool.query(`
            SELECT column_name, data_type, is_nullable
            FROM information_schema.columns
            WHERE table_name = 'customers'
            ORDER BY ordinal_position
        `);

        console.log('\nCustomers table columns:');
        columnsCheck.rows.forEach(col => {
            console.log(`   • ${col.column_name.padEnd(25)} ${col.data_type.padEnd(20)} ${col.is_nullable === 'YES' ? 'NULL' : 'NOT NULL'}`);
        });

        console.log('\n✅ All migrations completed!');

    } catch (error) {
        console.error('❌ Fatal error:', error.message);
        console.error(error);
        process.exit(1);
    } finally {
        await pool.end();
    }
}

runMigrations();
