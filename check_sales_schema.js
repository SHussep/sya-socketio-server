const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function checkSchema() {
    try {
        // Verificar columnas de la tabla sales
        const result = await pool.query(`
            SELECT column_name, data_type, is_nullable
            FROM information_schema.columns
            WHERE table_name = 'sales'
            ORDER BY ordinal_position
        `);

        console.log('\n📋 Columnas de la tabla sales:');
        result.rows.forEach(col => {
            console.log(`  - ${col.column_name}: ${col.data_type} ${col.is_nullable === 'NO' ? '(NOT NULL)' : '(nullable)'}`);
        });

        // Intentar insertar una venta de prueba
        console.log('\n🧪 Intentando insertar venta de prueba...');
        const testInsert = await pool.query(`
            INSERT INTO sales (tenant_id, branch_id, employee_id, ticket_number, total_amount, payment_method)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING *
        `, [1, 1, null, 'TEST-001', 100, 'Efectivo']);

        console.log('✅ Inserción exitosa:', testInsert.rows[0]);

        // Limpiar
        await pool.query('DELETE FROM sales WHERE ticket_number = $1', ['TEST-001']);
        console.log('🧹 Venta de prueba eliminada');

        await pool.end();
    } catch (error) {
        console.error('❌ Error:', error.message);
        console.error('Detalle:', error.detail || 'N/A');
        await pool.end();
        process.exit(1);
    }
}

checkSchema();
