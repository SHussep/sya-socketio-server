const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function analyzeGuardianSystem() {
    try {
        console.log('🔍 ANALIZANDO SISTEMA GUARDIAN\n');
        console.log('═══════════════════════════════════════════════════════════\n');

        // 1. Verificar estructura de guardian_employee_scores_daily
        console.log('📋 TABLA: guardian_employee_scores_daily\n');
        const scoresStructure = await pool.query(`
            SELECT column_name, data_type, is_nullable
            FROM information_schema.columns
            WHERE table_name = 'guardian_employee_scores_daily'
            ORDER BY ordinal_position
        `);

        if (scoresStructure.rows.length > 0) {
            console.log('Estructura:');
            scoresStructure.rows.forEach(col => {
                console.log(`  - ${col.column_name.padEnd(30)} ${col.data_type.padEnd(30)} ${col.is_nullable === 'NO' ? 'NOT NULL' : 'NULLABLE'}`);
            });
        } else {
            console.log('⚠️ Tabla NO existe');
        }

        // 2. Verificar datos en guardian_employee_scores_daily
        const scoresData = await pool.query(`
            SELECT COUNT(*) as total FROM guardian_employee_scores_daily
        `);
        console.log(`\nRegistros totales: ${scoresData.rows[0].total}\n`);

        if (scoresData.rows[0].total > 0) {
            const sample = await pool.query(`
                SELECT * FROM guardian_employee_scores_daily
                ORDER BY date DESC
                LIMIT 3
            `);
            console.log('Últimos 3 registros:');
            sample.rows.forEach((row, i) => {
                console.log(`\n${i + 1}. ${JSON.stringify(row, null, 2)}`);
            });
        }

        console.log('\n═══════════════════════════════════════════════════════════\n');

        // 3. Analizar suspicious_weighing_logs (Guardian events)
        console.log('📋 TABLA: suspicious_weighing_logs\n');

        const guardianEvents = await pool.query(`
            SELECT
                event_type,
                severity,
                COUNT(*) as total,
                AVG(risk_score) as avg_risk,
                AVG(points_assigned) as avg_points
            FROM suspicious_weighing_logs
            GROUP BY event_type, severity
            ORDER BY total DESC
        `);

        console.log('Eventos por tipo:\n');
        guardianEvents.rows.forEach(row => {
            console.log(`  ${row.event_type.padEnd(40)} | ${row.severity.padEnd(10)} | Count: ${row.total} | Avg Risk: ${parseFloat(row.avg_risk).toFixed(2)} | Avg Points: ${parseFloat(row.avg_points).toFixed(2)}`);
        });

        console.log('\n═══════════════════════════════════════════════════════════\n');

        // 4. Analizar scale_disconnection_logs
        console.log('📋 TABLA: scale_disconnection_logs\n');

        const disconnections = await pool.query(`
            SELECT
                status,
                COUNT(*) as total,
                AVG(duration_minutes) as avg_duration,
                MAX(duration_minutes) as max_duration,
                MIN(duration_minutes) as min_duration
            FROM scale_disconnection_logs
            GROUP BY status
        `);

        console.log('Desconexiones por estado:\n');
        disconnections.rows.forEach(row => {
            console.log(`  ${row.status.padEnd(15)} | Total: ${row.total} | Avg: ${parseFloat(row.avg_duration).toFixed(2)}min | Max: ${parseFloat(row.max_duration).toFixed(2)}min | Min: ${parseFloat(row.min_duration).toFixed(2)}min`);
        });

        console.log('\n═══════════════════════════════════════════════════════════\n');

        // 5. Verificar tabla scale_disconnections antigua
        const oldTable = await pool.query(`
            SELECT EXISTS (
                SELECT FROM information_schema.tables
                WHERE table_name = 'scale_disconnections'
            ) as exists
        `);

        console.log('📋 TABLA OBSOLETA: scale_disconnections\n');
        console.log(`  Estado: ${oldTable.rows[0].exists ? '❌ EXISTE (debe eliminarse)' : '✅ No existe'}\n`);

        await pool.end();
    } catch (error) {
        console.error('❌ Error:', error.message);
        await pool.end();
        process.exit(1);
    }
}

analyzeGuardianSystem();
