require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
});

async function testConnection() {
    try {
        console.log('🔍 Probando conexión a PostgreSQL...\n');
        console.log('📍 DATABASE_URL:', process.env.DATABASE_URL.replace(/:[^:]*@/, ':***@'));
        
        const client = await pool.connect();
        console.log('✅ Conexión exitosa!\n');
        
        // Test simple query
        const result = await client.query('SELECT NOW()');
        console.log('⏰ Hora del servidor:', result.rows[0]);
        
        // Get database info
        const dbInfo = await client.query(`
            SELECT datname, pg_size_pretty(pg_database_size(datname)) as size
            FROM pg_database 
            WHERE datname = current_database()
        `);
        console.log('\n📊 Información de BD:', dbInfo.rows[0]);
        
        // Count records
        const counts = await client.query(`
            SELECT 
                'sales' as tabla, COUNT(*) as count FROM sales
            UNION ALL
            SELECT 'sales_items', COUNT(*) FROM sales_items
            UNION ALL
            SELECT 'expenses', COUNT(*) FROM expenses
            UNION ALL
            SELECT 'cash_cuts', COUNT(*) FROM cash_cuts
            UNION ALL
            SELECT 'tenants', COUNT(*) FROM tenants
            UNION ALL
            SELECT 'employees', COUNT(*) FROM employees
        `);
        
        console.log('\n📈 Conteo de registros:');
        counts.rows.forEach(row => {
            console.log(`   ${row.tabla}: ${row.count}`);
        });
        
        client.release();
        console.log('\n✅ Prueba de conexión completada');
        await pool.end();
        process.exit(0);
        
    } catch (error) {
        console.error('❌ Error de conexión:', error.message);
        console.error('Code:', error.code);
        await pool.end();
        process.exit(1);
    }
}

testConnection();
