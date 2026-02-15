require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function checkSchema() {
    console.log('\n=== SCHEMA: branches ===');
    const branches = await pool.query(`
        SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
        WHERE table_name = 'branches'
        ORDER BY ordinal_position
    `);
    console.table(branches.rows);

    console.log('\n=== SCHEMA: employee_branches ===');
    const empBranches = await pool.query(`
        SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
        WHERE table_name = 'employee_branches'
        ORDER BY ordinal_position
    `);
    console.table(empBranches.rows);

    await pool.end();
}

checkSchema().catch(console.error);
