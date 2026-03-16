const { Pool } = require('pg');
require('dotenv').config();
const fs = require('fs');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function run() {
    const sql = fs.readFileSync('./migrations/create_followup_emails.sql', 'utf8');
    console.log('Running migration: create_followup_emails.sql');
    await pool.query(sql);
    console.log('Migration completed successfully');
    await pool.end();
}

run().catch(e => { console.error(e); process.exit(1); });
