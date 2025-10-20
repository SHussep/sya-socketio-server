// Script para verificar datos del tenant 7
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function check() {
    try {
        const sales = await pool.query('SELECT * FROM sales WHERE tenant_id = 7');
        const expenses = await pool.query('SELECT * FROM expenses WHERE tenant_id = 7');
        const cashCuts = await pool.query('SELECT * FROM cash_cuts WHERE tenant_id = 7');
        const backups = await pool.query('SELECT * FROM backup_metadata WHERE tenant_id = 7 ORDER BY created_at DESC');
        const branches = await pool.query('SELECT * FROM branches WHERE tenant_id = 7');

        console.log('\n=== TENANT 7: EL CANGURO VOLADOR ===\n');
        console.log('Branches:', branches.rows.length);
        console.log('Sales:', sales.rows.length);
        console.log('Expenses:', expenses.rows.length);
        console.log('Cash Cuts:', cashCuts.rows.length);
        console.log('Backups:', backups.rows.length);

        if (branches.rows.length > 0) {
            console.log('\n=== BRANCHES ===');
            branches.rows.forEach(b => {
                console.log(`ID: ${b.id} | Name: ${b.name} | Code: ${b.branch_code}`);
            });
        }

        if (backups.rows.length > 0) {
            console.log('\n=== BACKUPS ===');
            backups.rows.forEach(b => {
                console.log(`ID: ${b.id} | Branch: ${b.branch_id} | File: ${b.backup_filename}`);
                console.log(`  Created: ${b.created_at} | Size: ${(b.file_size_bytes / 1024).toFixed(2)} KB`);
                console.log(`  Path: ${b.backup_path}`);
            });
        }

        if (sales.rows.length > 0) {
            console.log('\n=== SALES ===');
            sales.rows.forEach(s => {
                console.log(`ID: ${s.id} | Branch: ${s.branch_id} | Total: $${s.total_amount}`);
                console.log(`  Date: ${s.sale_date} | Kilos: ${s.total_kilos}`);
            });
        }

        await pool.end();
        process.exit(0);
    } catch (error) {
        console.error('Error:', error);
        await pool.end();
        process.exit(1);
    }
}

check();
