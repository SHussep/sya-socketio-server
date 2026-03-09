// ═══════════════════════════════════════════════════════════════
// DATABASE POOL - PostgreSQL Connection + UTC Wrapper
// ═══════════════════════════════════════════════════════════════

const { Pool } = require('pg');
require('dotenv').config();

const rawPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // Render managed PostgreSQL uses self-signed certificates
    // rejectUnauthorized: false is required for Render's internal network
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// 🌍 CRITICAL: Set timezone to UTC for ALL connections
// This ensures PostgreSQL interprets all timestamps in UTC, not in system timezone
rawPool.on('connect', async (client) => {
    try {
        await client.query("SET timezone = 'UTC'");
        console.log('✅ Connected to PostgreSQL database (timezone: UTC)');
    } catch (error) {
        console.error('❌ Error setting timezone:', error.message);
    }
});

rawPool.on('error', (err) => {
    console.error('❌ Unexpected error on idle client', err);
    process.exit(-1);
});

// 🌍 WRAPPER: Ensure timezone is UTC for EVERY database operation
class UTCPoolWrapper {
    constructor(pgPool) {
        this.pool = pgPool;
    }

    // For queries that don't need a persistent connection
    async query(text, values) {
        const client = await this.pool.connect();
        try {
            await client.query("SET timezone = 'UTC'");
            return await client.query(text, values);
        } finally {
            client.release();
        }
    }

    // For code that uses pool.connect() directly and needs persistent connection
    async connect() {
        const client = await this.pool.connect();
        try {
            await client.query("SET timezone = 'UTC'");
        } catch (error) {
            console.error('❌ Error setting timezone on connected client:', error.message);
            client.release();
            throw error;
        }

        const originalQuery = client.query.bind(client);
        client.query = function(text, values, callback) {
            if (typeof callback === 'function') {
                return originalQuery(text, values, callback);
            }
            return originalQuery(text, values);
        };

        return client;
    }

    on(event, callback) {
        return this.pool.on(event, callback);
    }
}

const pool = new UTCPoolWrapper(rawPool);

module.exports = { rawPool, pool };
