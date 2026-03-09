// Script para crear tabla device_tokens en PostgreSQL
const { pool } = require('./database');

async function createDeviceTokensTable() {
    const client = await pool.connect();
    try {
        console.log('Creating device_tokens table...');

        await client.query(`
            CREATE TABLE IF NOT EXISTS device_tokens (
                id SERIAL PRIMARY KEY,
                employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
                branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
                device_token TEXT NOT NULL UNIQUE,
                platform VARCHAR(50) NOT NULL, -- 'android' or 'ios'
                device_name VARCHAR(255),
                is_active BOOLEAN DEFAULT true,
                last_used_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        console.log('✅ device_tokens table created successfully');

        // Create index for faster lookups
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_device_tokens_employee_id
            ON device_tokens(employee_id);
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_device_tokens_branch_id
            ON device_tokens(branch_id);
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_device_tokens_is_active
            ON device_tokens(is_active);
        `);

        console.log('✅ Indexes created successfully');

    } catch (error) {
        console.error('❌ Error creating device_tokens table:', error.message);
        throw error;
    } finally {
        client.release();
        process.exit(0);
    }
}

createDeviceTokensTable();
