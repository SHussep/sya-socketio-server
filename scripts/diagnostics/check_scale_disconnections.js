const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function checkScaleDisconnections() {
    try {
        console.log('🔍 Consultando tabla scale_disconnection_logs...\n');

        // Verificar si la tabla existe
        const tableExists = await pool.query(`
            SELECT EXISTS (
                SELECT FROM information_schema.tables
                WHERE table_name = 'scale_disconnection_logs'
            );
        `);

        if (!tableExists.rows[0].exists) {
            console.log('❌ La tabla scale_disconnection_logs NO existe');
            await pool.end();
            return;
        }

        console.log('✅ Tabla scale_disconnection_logs existe\n');

        // Obtener todos los registros
        const result = await pool.query(`
            SELECT
                id,
                tenant_id,
                branch_id,
                shift_id,
                employee_id,
                disconnected_at,
                reconnected_at,
                duration_minutes,
                status,
                reason,
                global_id,
                created_at
            FROM scale_disconnection_logs
            ORDER BY disconnected_at DESC
            LIMIT 10
        `);

        console.log(`📊 Total de registros: ${result.rows.length}\n`);

        if (result.rows.length > 0) {
            console.log('📋 Últimos 10 registros:\n');
            result.rows.forEach((row, index) => {
                console.log(`${index + 1}. ID: ${row.id}`);
                console.log(`   Tenant: ${row.tenant_id}, Branch: ${row.branch_id}, Employee: ${row.employee_id}`);
                console.log(`   Desconectado: ${row.disconnected_at}`);
                console.log(`   Reconectado: ${row.reconnected_at || 'AÚN DESCONECTADO'}`);
                console.log(`   Duración: ${row.duration_minutes} min`);
                console.log(`   Status: ${row.status}`);
                console.log(`   Reason: ${row.reason || 'N/A'}`);
                console.log(`   GlobalId: ${row.global_id}`);
                console.log(`   Creado: ${row.created_at}`);
                console.log('');
            });
        } else {
            console.log('⚠️ No hay registros en la tabla');
        }

        await pool.end();
    } catch (error) {
        console.error('❌ Error:', error.message);
        await pool.end();
        process.exit(1);
    }
}

checkScaleDisconnections();
