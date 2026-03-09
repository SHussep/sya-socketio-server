// Hacer employee_id nullable en backup_metadata
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function fixEmployeeId() {
    try {
        console.log('\n🔧 Modificando tabla backup_metadata...\n');

        await pool.query(`
            ALTER TABLE backup_metadata
            ALTER COLUMN employee_id DROP NOT NULL;
        `);

        console.log('✅ SUCCESS: employee_id ahora permite valores NULL\n');
        console.log('Esto permite que los backups desde Desktop no requieran employee_id.\n');

        await pool.end();
        process.exit(0);

    } catch (error) {
        if (error.message.includes('column "employee_id" of relation "backup_metadata" is not a not-null constraint')) {
            console.log('✅ Ya está configurado: employee_id ya permite NULL\n');
            await pool.end();
            process.exit(0);
        } else {
            console.error('❌ Error:', error.message);
            await pool.end();
            process.exit(1);
        }
    }
}

fixEmployeeId();
