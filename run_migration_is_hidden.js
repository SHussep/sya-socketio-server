const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function runMigration() {
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║   🚀 MIGRATION: Add is_hidden to Guardian tables         ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    try {
        // ═══════════════════════════════════════════════════════════════
        // 1. Add is_hidden to suspicious_weighing_logs
        // ═══════════════════════════════════════════════════════════════
        console.log('🔄 Adding is_hidden to suspicious_weighing_logs...');

        const checkColumn1 = await pool.query(`
            SELECT column_name FROM information_schema.columns
            WHERE table_name = 'suspicious_weighing_logs' AND column_name = 'is_hidden'
        `);

        if (checkColumn1.rows.length === 0) {
            await pool.query(`
                ALTER TABLE suspicious_weighing_logs
                ADD COLUMN is_hidden BOOLEAN DEFAULT FALSE
            `);
            console.log('   ✅ is_hidden added to suspicious_weighing_logs');
        } else {
            console.log('   ⏭️ is_hidden already exists in suspicious_weighing_logs');
        }

        // ═══════════════════════════════════════════════════════════════
        // 2. Add is_hidden to scale_disconnection_logs
        // ═══════════════════════════════════════════════════════════════
        console.log('🔄 Adding is_hidden to scale_disconnection_logs...');

        const checkColumn2 = await pool.query(`
            SELECT column_name FROM information_schema.columns
            WHERE table_name = 'scale_disconnection_logs' AND column_name = 'is_hidden'
        `);

        if (checkColumn2.rows.length === 0) {
            await pool.query(`
                ALTER TABLE scale_disconnection_logs
                ADD COLUMN is_hidden BOOLEAN DEFAULT FALSE
            `);
            console.log('   ✅ is_hidden added to scale_disconnection_logs');
        } else {
            console.log('   ⏭️ is_hidden already exists in scale_disconnection_logs');
        }

        // ═══════════════════════════════════════════════════════════════
        // 3. Add indexes for is_hidden queries
        // ═══════════════════════════════════════════════════════════════
        console.log('🔄 Creating indexes...');

        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_suspicious_weighing_logs_is_hidden
            ON suspicious_weighing_logs(is_hidden) WHERE is_hidden = false
        `);

        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_scale_disconnection_logs_is_hidden
            ON scale_disconnection_logs(is_hidden) WHERE is_hidden = false
        `);

        console.log('   ✅ Indexes created');

        console.log('\n═══════════════════════════════════════════════════════════');
        console.log('✅ Migration completed - is_hidden columns added');
        console.log('═══════════════════════════════════════════════════════════\n');

        await pool.end();
        process.exit(0);

    } catch (error) {
        console.error('\n❌ Error executing migration:');
        console.error(error.message);
        await pool.end();
        process.exit(1);
    }
}

runMigration();
